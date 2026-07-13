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
from datetime import datetime, timezone
from pathlib import Path
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


def scrape_url(page, url, marca):
    intentos = 3
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
        print(f"   Intento {int_num}/{intentos}...", flush=True)
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
                    result["error"] = "Producto no disponible o enlace roto (404)"
                    return result
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

    print("")
    print("Scrapeando " + str(len(filas_farmatodo)) + " URLs de Farmatodo...")
    print("")
    inicio = time.time()
    resultados = []

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
        )
        page = context.new_page()

        for i, fila in enumerate(filas_farmatodo, 1):
            marca = str(fila.get("marca", "")).strip() or "?"
            tipo = str(fila.get("tipo", "")).strip() or "?"
            url = str(fila.get("url", "")).strip()
            id_prod = str(fila.get("id_producto_propio", "")).strip()

            print("[" + str(i) + "/" + str(len(filas_farmatodo)) + "] "
                  + marca + " (" + tipo + ") - " + id_prod, flush=True)

            if not url:
                print("   SKIP: URL vacia")
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
                    r = scrape_url(page, url, marca)
                except Exception as e:
                    print("   ERROR INESPERADO: " + str(e))
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
            resultados.append(r)

            if r["error"]:
                print("   ERROR: " + r["error"])
            else:
                if r["tiene_descuento"]:
                    pct = (1 - r["precio_desc_bs"] / r["precio_full_bs"]) * 100
                    print("   OK: Bs " + "{:,.2f}".format(r["precio_full_bs"]) +
                          " -> Bs " + "{:,.2f}".format(r["precio_desc_bs"]) +
                          "  (-" + "{:.0f}".format(pct) + "%)")
                else:
                    print("   OK: Bs " + "{:,.2f}".format(r["precio_full_bs"]))
            print("")

        browser.close()

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
