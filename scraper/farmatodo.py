# Scraper de Farmatodo - version 4
#
# Mejoras respecto a v3:
# - Lee productos_competencia desde Firestore (no del CSV)
# - Filtro de cadena case-insensitive y tolerante a espacios
# - Logs claros: cuantas filas hay, cuantas son Farmatodo, cuantas activas
# - Cada URL marca su estado correctamente
# - Si una URL falla, las demas siguen corriendo

import csv
import io
import json
import re
import sys
import time
import random
from datetime import datetime, timezone
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeout


PROJECT_ROOT = Path(__file__).parent.parent
CSV_PATH = PROJECT_ROOT / "productos_competencia.csv"
RESULTS_PATH = PROJECT_ROOT / "resultados.json"
DEBUG_DIR = PROJECT_ROOT / "debug"


def read_text_robust(path):
    raw = path.read_bytes()
    for encoding in ("utf-8", "utf-8-sig", "cp1252", "latin-1"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    raise RuntimeError("No pude decodificar " + path.name)


def parse_price(text):
    if not text:
        return None
    cleaned = text.replace("Bs.", "").replace("Bs", "").strip()
    cleaned = re.sub(r"[^\d.,]", "", cleaned)
    if not cleaned:
        return None
    
    if "," in cleaned:
        # Venezuelan format: dot is thousands, comma is decimal
        cleaned = cleaned.replace(".", "").replace(",", ".")
    else:
        # No comma. Only dots might exist.
        if cleaned.count(".") == 1:
            parts = cleaned.split(".")
            if len(parts[1]) == 3:  # Single dot followed by 3 digits is likely thousands
                cleaned = cleaned.replace(".", "")
        elif cleaned.count(".") > 1:
            cleaned = cleaned.replace(".", "")
            
    try:
        return float(cleaned)
    except ValueError:
        return None


def cargar_filas_de_firestore():
    """Lee productos_competencia desde Firestore (fuente de verdad)."""
    try:
        from firebase_client import get_db
        db = get_db()
        snap = db.collection("productos_competencia").stream()
        filas = []
        for doc in snap:
            data = doc.to_dict()
            data["_doc_id"] = doc.id
            filas.append(data)
        print("Cargadas " + str(len(filas)) + " filas desde Firestore")
        return filas
    except Exception as e:
        print("No pude cargar desde Firestore: " + str(e))
        return None


def cargar_filas_de_csv():
    """Fallback: lee productos_competencia desde el CSV local."""
    if not CSV_PATH.exists():
        return []
    text = read_text_robust(CSV_PATH)
    sample = text[:2048]
    delim = ";" if sample.count(";") > sample.count(",") else ","
    filas = []
    for row in csv.DictReader(io.StringIO(text), delimiter=delim):
        filas.append(row)
    print("Cargadas " + str(len(filas)) + " filas desde CSV local (fallback)")
    return filas


def scrape_url(page, url, marca, thread_id=1):
    intentos = 4
    result = {
        "url": url,
        "marca": marca,
        "nombre": None,
        "precio_full_bs": None,
        "precio_desc_bs": None,
        "tiene_descuento": False,
        "scraped_at": datetime.now(timezone.utc).isoformat(),
        "error": None,
    }

    for int_num in range(1, intentos + 1):
        print(f"   [Hilo {thread_id}] Intento {int_num}/{intentos}...", flush=True)
        # Reset errors and values for each retry
        result["error"] = None
        result["precio_full_bs"] = None
        result["precio_desc_bs"] = None
        result["tiene_descuento"] = False

        try:
            # Incrementar el timeout de carga progresivamente en cada reintento
            timeout = 30000 + (int_num - 1) * 10000
            response = page.goto(url, wait_until="domcontentloaded", timeout=timeout)
            if response and response.status >= 400:
                result["error"] = f"HTTP {response.status}"
                # Si el producto tiene un código 404 (no existe), no tiene sentido reintentar
                if response.status == 404:
                    result["error"] = "Producto no disponible o enlace roto (404 / Agotado)."
                    return result
                if response.status == 429:
                    backoff_sec = 8 * int_num + random.uniform(3, 8)
                    print(f"   [Hilo {thread_id}] ⚠️ HTTP 429 (Too Many Requests) detectado! Esperando {backoff_sec:.1f}s (Backoff)...", flush=True)
                    time.sleep(backoff_sec)
                    continue
                if response.status == 403:
                    backoff_sec = 10 * int_num + random.uniform(5, 10)
                    print(f"   [Hilo {thread_id}] ⚠️ HTTP 403 (Forbidden/Blocked) detectado! Esperando {backoff_sec:.1f}s (Backoff)...", flush=True)
                    time.sleep(backoff_sec)
                    continue
                time.sleep(2)
                continue
        except PlaywrightTimeout:
            result["error"] = "Timeout cargando la página"
            time.sleep(2)
            continue
        except Exception as e:
            result["error"] = f"Error de red/carga: {type(e).__name__}"
            time.sleep(2)
            continue

        print("   Esperando contenido...", flush=True)
        try:
            # Esperar a que el h1 de la página esté cargado
            page.wait_for_selector("h1", timeout=8000)
        except PlaywrightTimeout:
            pass

        # CRÍTICO: Esperar de forma inteligente a que los precios se carguen vía llamadas asíncronas
        try:
            # Esperamos hasta 6 segundos que el texto "Bs" (común en Farmatodo Vzla) se renderice en el DOM
            page.wait_for_selector("text=/Bs/i", timeout=6000)
        except PlaywrightTimeout:
            # Si no aparece "Bs", esperamos por cualquier selector de clase que contenga "price"
            try:
                page.wait_for_selector(".product-purchase__price, [class*='price']", timeout=3000)
            except PlaywrightTimeout:
                pass

        # Desplazamiento sutil para simular actividad del usuario y gatillar hidratación de React/Next.js
        try:
            page.evaluate("window.scrollTo(0, 300)")
            time.sleep(1.0)
            page.evaluate("window.scrollTo(0, 0)")
            time.sleep(1.0)
        except Exception:
            pass

        print("   Extrayendo datos...", flush=True)
        data = page.evaluate("""
            () => {
                // 1. Detectar bloqueo o Cloudflare
                const bodyText = document.body ? document.body.innerText || '' : '';
                const title = document.title || '';
                const isCloudflare = title.includes('Cloudflare') || 
                                     title.includes('Just a moment') || 
                                     bodyText.includes('Checking your browser') ||
                                     bodyText.includes('Access Denied') ||
                                     bodyText.includes('enable JavaScript') ||
                                     bodyText.includes('Attention Required!');
                if (isCloudflare) {
                    return {
                        error: "La página bloqueó el acceso temporalmente (Sistema de seguridad Cloudflare / Protección contra Robots). Intenta de nuevo en unos minutos."
                    };
                }

                // 2. Extraer H1 (nombre del producto)
                const h1El = document.querySelector('h1');
                let nombre = h1El ? (h1El.innerText || h1El.textContent || '').trim() : null;

                if (!nombre || !nombre.trim()) {
                    const titleEl = document.querySelector('[class*="product-name"], [class*="title-product"]');
                    if (titleEl) nombre = (titleEl.innerText || titleEl.textContent || '').trim();
                }

                if (!nombre || !nombre.trim()) {
                    nombre = document.title.split('|')[0].split('-')[0].trim();
                }

                // Detectar si el producto no está disponible o el enlace está roto
                const isNotFound = title.includes('404') || 
                                   bodyText.includes('Producto no disponible') || 
                                   bodyText.includes('No pudimos encontrar') ||
                                   bodyText.includes('no encontrado') ||
                                   (nombre && nombre.toLowerCase().includes('no encontrado'));
                if (isNotFound) {
                    return {
                        nombre,
                        error: "Producto no disponible o enlace roto (404 / Agotado)."
                    };
                }

                // 3. Buscar contenedor de compra principal para delimitar la búsqueda de precios y evitar sugeridos
                let container = document.querySelector('.product-purchase') || 
                                document.querySelector('[class*="product-purchase"]') ||
                                document.querySelector('[class*="purchase-container"]') ||
                                document.querySelector('[class*="buy-box"]') ||
                                document.querySelector('[class*="price-container"]') ||
                                document.querySelector('.product-info') ||
                                document.querySelector('[class*="product-info"]');
                
                if (!container && h1El) {
                    let cur = h1El;
                    for (let i = 0; i < 5; i++) {
                        if (!cur || cur === document.body) break;
                        const text = cur.innerText || cur.textContent || '';
                        if (text.includes('Bs') || text.match(/\\d+[,.]\\d{2}/)) {
                            container = cur;
                            break;
                        }
                        cur = cur.parentElement;
                    }
                }

                // Funciones de parseo interno de JS
                function jsParsePrice(cleaned) {
                    if (!cleaned) return null;
                    cleaned = cleaned.replace(/[^\\d.,]/g, '');
                    if (!cleaned) return null;
                    
                    if (cleaned.includes(',')) {
                        cleaned = cleaned.replace(/\\./g, '').replace(/,/g, '.');
                    } else {
                        const dotCount = (cleaned.match(/\\./g) || []).length;
                        if (dotCount === 1) {
                            const parts = cleaned.split('.');
                            if (parts[1].length === 3) {
                                cleaned = cleaned.replace(/\\./g, '');
                            }
                        } else if (dotCount > 1) {
                            cleaned = cleaned.replace(/\\./g, '');
                        }
                    }
                    const val = parseFloat(cleaned);
                    return isNaN(val) ? null : val;
                }

                function extractPricesFromText(text) {
                    if (!text) return [];
                    const regex = /(?:Bs\\.?|Ref\\.?|\\$)?\\s*(\\d+(?:[.,]\\d+)*)/gi;
                    const matches = [];
                    let m;
                    while ((m = regex.exec(text)) !== null) {
                        const num = jsParsePrice(m[1]);
                        if (num !== null && num > 0.1 && num < 100000) {
                            matches.push(num);
                        }
                    }
                    return matches;
                }

                // 4. Buscar precios vía JSON-LD (datos estructurados) como primer recurso para precio activo
                let metaActive = null;
                const jsonLdScripts = document.querySelectorAll('script[type="application/ld+json"]');
                for (const script of jsonLdScripts) {
                    try {
                        const parsed = JSON.parse(script.textContent || '');
                        const findProductPrice = (obj) => {
                            if (!obj) return null;
                            if (obj['@type'] === 'Product' || obj['@type'] === 'http://schema.org/Product') {
                                if (obj.offers) {
                                    if (Array.isArray(obj.offers)) {
                                        return obj.offers[0].price || obj.offers[0].lowPrice;
                                    } else if (obj.offers.price) {
                                        return obj.offers.price;
                                    } else if (obj.offers.lowPrice) {
                                        return obj.offers.lowPrice;
                                    }
                                }
                            }
                            if (Array.isArray(obj)) {
                                for (const item of obj) {
                                    const p = findProductPrice(item);
                                    if (p) return p;
                                }
                            } else if (typeof obj === 'object') {
                                for (const key of Object.keys(obj)) {
                                    const p = findProductPrice(obj[key]);
                                    if (p) return p;
                                }
                            }
                            return null;
                        };
                        const p = findProductPrice(parsed);
                        if (p) {
                            metaActive = String(p);
                            break;
                        }
                    } catch(e) {}
                }

                if (!metaActive) {
                    const metaPriceAmount = document.querySelector('meta[property="product:price:amount"]') || 
                                            document.querySelector('meta[property="og:price:amount"]') ||
                                            document.querySelector('meta[itemprop="price"]');
                    if (metaPriceAmount) {
                        metaActive = metaPriceAmount.getAttribute('content');
                    }
                }

                // 5. Selectores clásicos y experimentales
                const activeSelectors = [
                    'span.product-purchase__price--active',
                    '.product-purchase__price--active',
                    '[class*="price--active"]',
                    '.product-purchase__price',
                    'span.price',
                    '[class*="product-price"]',
                    '[class*="price_active"]',
                    '[class*="price-active"]',
                    '[class*="price-member"]',
                    '[class*="member-price"]',
                    '[class*="discount"]'
                ];
                
                const originalSelectors = [
                    'del.product-purchase__price--original',
                    'del',
                    '[class*="price--original"]',
                    '.product-purchase__price-original',
                    '[class*="price_original"]',
                    '[class*="price-original"]',
                    'span.product-purchase__price-original',
                    '[class*="old-price"]',
                    '[class*="list-price"]'
                ];

                let activeEl = null;
                for (const sel of activeSelectors) {
                    const el = container ? container.querySelector(sel) : document.querySelector(sel);
                    if (el) { activeEl = el; break; }
                }

                let originalEl = null;
                for (const sel of originalSelectors) {
                    const el = container ? container.querySelector(sel) : document.querySelector(sel);
                    if (el) { originalEl = el; break; }
                }

                let active_text = activeEl ? (activeEl.innerText || activeEl.textContent || '').trim() : null;
                let original_text = originalEl ? (originalEl.innerText || originalEl.textContent || '').trim() : null;

                if (!active_text && metaActive) {
                    active_text = metaActive;
                }

                // 6. Extracción heurística por bloque de texto de la caja de compra
                const containerText = container ? (container.innerText || container.textContent || '') : '';
                const blockPrices = extractPricesFromText(containerText);

                return {
                    active_text: active_text,
                    original_text: original_text,
                    nombre: nombre,
                    block_prices: blockPrices
                };
            }
        """)

        if data.get("error"):
            result["error"] = data["error"]
            result["nombre"] = data.get("nombre")
            # Si realmente no está disponible (404 / Agotado), retornamos inmediatamente
            if "enlace roto" in data["error"] or "404" in data["error"] or "disponible" in data["error"]:
                return result
            
            # Si es un bloqueo por Cloudflare/Robots, dormimos más tiempo y reintentamos
            if "Cloudflare" in data["error"] or "bloqueó" in data["error"]:
                backoff_sec = 12 * int_num + random.uniform(5, 12)
                print(f"   [Hilo {thread_id}] ⚠️ Bloqueo de seguridad detectado en contenido. Esperando {backoff_sec:.1f}s...", flush=True)
                time.sleep(backoff_sec)
            else:
                time.sleep(2)
            continue

        result["nombre"] = data.get("nombre")
        precio_activo = parse_price(data.get("active_text"))
        precio_original = parse_price(data.get("original_text"))

        # Si los selectores de clases fallaron, pero pudimos extraer números del bloque de compra:
        block_prices = data.get("block_prices", [])
        if (precio_activo is None) and block_prices:
            unique_prices = sorted(list(set(block_prices)))
            if len(unique_prices) == 1:
                precio_activo = unique_prices[0]
            elif len(unique_prices) >= 2:
                # El menor es el activo/oferta, el mayor es el original
                precio_activo = unique_prices[0]
                precio_original = unique_prices[-1]

        if precio_original is not None and precio_activo is not None:
            if precio_original > precio_activo:
                result["precio_full_bs"] = precio_original
                result["precio_desc_bs"] = precio_activo
                result["tiene_descuento"] = True
            else:
                result["precio_full_bs"] = precio_activo
            break  # Éxito!
        elif precio_activo is not None:
            result["precio_full_bs"] = precio_activo
            break  # Éxito!
        else:
            if not result.get("nombre"):
                result["error"] = "No se pudo cargar la estructura de la página (posible bloqueo o error de red)."
            else:
                result["error"] = "Precio no encontrado en la página (agotado o sin precio visible)."
            time.sleep(2)
            # Reintentar

    return result


def main():
    # Primero intentamos Firestore (lo que se ve en el panel),
    # caemos al CSV si falla.
    filas_todas = cargar_filas_de_firestore()
    if filas_todas is None:
        filas_todas = cargar_filas_de_csv()

    if not filas_todas:
        print("ERROR: no hay filas en Firestore ni en CSV")
        sys.exit(1)

    # FILTRO ROBUSTO: case-insensitive, tolerante a espacios extra
    filas_farmatodo = []
    filas_otras_cadenas = []
    filas_inactivas = []

    for fila in filas_todas:
        cadena_raw = fila.get("cadena", "")
        cadena_norm = str(cadena_raw).strip().lower()

        activo_raw = fila.get("activo", "")
        if isinstance(activo_raw, bool):
            es_activa = activo_raw
        else:
            es_activa = str(activo_raw).strip().lower() in ("si", "sí", "true", "1", "yes")

        if not es_activa:
            filas_inactivas.append(fila)
            continue

        if cadena_norm == "farmatodo":
            filas_farmatodo.append(fila)
        else:
            filas_otras_cadenas.append(fila)

    print("")
    print("=" * 60)
    print("RESUMEN DE FILAS:")
    print("  Total en fuente:        " + str(len(filas_todas)))
    print("  De Farmatodo activas:   " + str(len(filas_farmatodo)))
    print("  De otras cadenas:       " + str(len(filas_otras_cadenas))
          + " (ignoradas, scraper no implementado)")
    print("  Inactivas:              " + str(len(filas_inactivas)))
    print("=" * 60)

    if filas_otras_cadenas:
        print("")
        print("Cadenas detectadas que no son Farmatodo:")
        cadenas_unicas = set(str(f.get("cadena", "")) for f in filas_otras_cadenas)
        for c in cadenas_unicas:
            cnt = sum(1 for f in filas_otras_cadenas if str(f.get("cadena", "")) == c)
            print("  - " + str(c) + ": " + str(cnt) + " URLs")
        print("")

    if not filas_farmatodo:
        print("No hay URLs activas de Farmatodo para scrapear.")
        sys.exit(0)

    # PARALELISMO SEGURO: Dividir el scraping en hilos concurrentes (máximo 4)
    NUM_THREADS = 4
    chunks = [filas_farmatodo[i::NUM_THREADS] for i in range(NUM_THREADS)]
    chunks = [c for c in chunks if c]  # Filtrar grupos vacíos

    print("")
    print(f"Scrapeando {len(filas_farmatodo)} URLs de Farmatodo usando {len(chunks)} hilos concurrentes...")
    print("")
    inicio = time.time()
    resultados = []

    def scrape_worker(thread_id, chunk_filas):
        if not chunk_filas:
            return []
        
        # Inicio escalonado para no saturar al servidor al mismo tiempo
        delay = (thread_id - 1) * 3.5
        if delay > 0:
            print(f"[Hilo {thread_id}] Esperando {delay:.1f}s para inicio escalonado...", flush=True)
            time.sleep(delay)
        
        thread_results = []
        print(f"[Hilo {thread_id}] Iniciando scraping para {len(chunk_filas)} productos...", flush=True)
        
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            context = browser.new_context(
                user_agent=(
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/120.0.0.0 Safari/537.36"
                ),
                viewport={"width": 1366, "height": 768},
                locale="es-VE",
                extra_http_headers={
                    "Accept-Language": "es-VE,es;q=0.9,en-US;q=0.8,en;q=0.7",
                    "Sec-Ch-Ua": '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
                    "Sec-Ch-Ua-Mobile": "?0",
                    "Sec-Ch-Ua-Platform": '"Windows"',
                }
            )
            
            # Ocultar indicador de automatización (burlar detección de headless)
            context.add_init_script("""
                Object.defineProperty(navigator, 'webdriver', {
                    get: () => undefined
                });
            """)
            
            page = context.new_page()
            
            # BLOQUEAR RECURSOS INNECESARIOS PARA OPTIMIZAR VELOCIDAD Y REDUCIR BLOQUEOS
            def block_unnecessary(route):
                req = route.request
                res_type = req.resource_type
                url_lower = req.url.lower()
                
                # Bloquear recursos pesados no textuales
                if res_type in ("image", "media", "font", "websocket"):
                    route.abort()
                    return
                
                # Bloquear scripts de analíticas, rastreo y telemetría
                analytics_keywords = (
                    "google-analytics", "analytics", "google-tag-manager", "googletagmanager", 
                    "facebook", "connect.facebook.net", "hotjar", "sentry", "datadog", 
                    "mixpanel", "doubleclick", "adservice", "amplitude"
                )
                if any(kw in url_lower for kw in analytics_keywords):
                    route.abort()
                    return
                
                route.continue_()

            page.route("**/*", block_unnecessary)
            
            print(f"[Hilo {thread_id}] Calentando sesión y ubicando (Caracas/Vzla)...", flush=True)
            try:
                page.goto("https://www.farmatodo.com.ve", wait_until="domcontentloaded", timeout=35000)
                time.sleep(4.0)  # Esperar a que carguen popups
                
                # Intentar hacer click en el botón de confirmación de ubicación si aparece
                page.evaluate("""
                    () => {
                        const elements = Array.from(document.querySelectorAll('button, a, div, span'));
                        
                        // 1. Buscar si hay una opción explícita para Caracas
                        const caracasBtn = elements.find(b => {
                            const t = (b.textContent || '').trim().toLowerCase();
                            return t === 'caracas' || t === 'caracas metropolitana';
                        });
                        if (caracasBtn) {
                            caracasBtn.click();
                            console.log('Ubicación: Caracas metropolitana seleccionada');
                            return;
                        }
                        
                        // 2. Buscar botones estándar de confirmación de ubicación de Farmatodo
                        const confirmarBtn = elements.find(b => {
                            const t = (b.textContent || '').trim();
                            return t.includes('Confirmar') || 
                                   t.includes('Aceptar') || 
                                   t.includes('Entendido') || 
                                   t.includes('Sí, aquí') ||
                                   t.includes('Usar esta ubicación');
                        });
                        if (confirmarBtn) {
                            confirmarBtn.click();
                            console.log('Ubicación: Confirmada');
                        }
                    }
                """)
                time.sleep(1.5)
            except Exception as e:
                print(f"[Hilo {thread_id}] Advertencia durante el calentamiento de sesión: {e}", flush=True)

            for i, fila in enumerate(chunk_filas, 1):
                # Intervalo de cortesía aleatorio entre peticiones para evitar bloqueos por tasa
                if i > 1:
                    sleep_time = random.uniform(2.0, 4.5)
                    print(f"[Hilo {thread_id}] Esperando intervalo de cortesía de {sleep_time:.1f}s...", flush=True)
                    time.sleep(sleep_time)

                marca = str(fila.get("marca", "")).strip() or "?"
                tipo = str(fila.get("tipo", "")).strip() or "?"
                url = str(fila.get("url", "")).strip()
                id_prod = str(fila.get("id_producto_propio", "")).strip()

                print(f"[Hilo {thread_id}] [{i}/{len(chunk_filas)}] {marca} ({tipo}) - {id_prod}", flush=True)

                if not url:
                    print(f"[Hilo {thread_id}]    SKIP: URL vacía", flush=True)
                    r = {
                        "url": "",
                        "marca": marca,
                        "nombre": None,
                        "precio_full_bs": None,
                        "precio_desc_bs": None,
                        "tiene_descuento": False,
                        "scraped_at": datetime.now(timezone.utc).isoformat(),
                        "error": "URL vacia",
                    }
                else:
                    try:
                        r = scrape_url(page, url, marca, thread_id=thread_id)
                    except Exception as e:
                        print(f"[Hilo {thread_id}]    ERROR INESPERADO: {e}", flush=True)
                        r = {
                            "url": url,
                            "marca": marca,
                            "nombre": None,
                            "precio_full_bs": None,
                            "precio_desc_bs": None,
                            "tiene_descuento": False,
                            "scraped_at": datetime.now(timezone.utc).isoformat(),
                            "error": "Error inesperado: " + str(e),
                        }

                r["id_producto_propio"] = id_prod
                r["cadena"] = "Farmatodo"
                r["tipo"] = tipo
                r["_doc_id"] = fila.get("_doc_id")
                r["laboratorio"] = fila.get("laboratorio")
                thread_results.append(r)

                if r["error"]:
                    print(f"[Hilo {thread_id}]    ERROR: {r['error']}", flush=True)
                else:
                    if r["tiene_descuento"]:
                        pct = (1 - r["precio_desc_bs"] / r["precio_full_bs"]) * 100
                        print(f"[Hilo {thread_id}]    OK: Bs {r['precio_full_bs']:,.2f} -> Bs {r['precio_desc_bs']:,.2f} (-{pct:.0f}%)", flush=True)
                    else:
                        print(f"[Hilo {thread_id}]    OK: Bs {r['precio_full_bs']:,.2f}", flush=True)
                print("", flush=True)

            browser.close()
        return thread_results

    with ThreadPoolExecutor(max_workers=len(chunks)) as executor:
        futures = {executor.submit(scrape_worker, i + 1, chunks[i]): i for i in range(len(chunks))}
        for future in as_completed(futures):
            try:
                res = future.result()
                resultados.extend(res)
            except Exception as e:
                print(f"Error crítico en hilo de scraping: {e}", flush=True)

    with open(RESULTS_PATH, "w", encoding="utf-8") as f:
        json.dump(resultados, f, ensure_ascii=False, indent=2, default=str)

    duracion = time.time() - inicio
    ok = sum(1 for r in resultados if not r["error"])
    print("=" * 60)
    print("Total: " + "{:.1f}".format(duracion) + "s | " +
          str(ok) + "/" + str(len(resultados)) + " OK")
    print("Resultados guardados en: " + str(RESULTS_PATH))


if __name__ == "__main__":
    main()
