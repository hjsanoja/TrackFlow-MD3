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


_LATEST_BCV_RATE = None

def get_latest_bcv_rate():
    global _LATEST_BCV_RATE
    if _LATEST_BCV_RATE is not None:
        return _LATEST_BCV_RATE
    try:
        from firebase_client import get_db
        db = get_db()
        docs = list(db.collection("bcv_rates").order_by("updated_at", direction="DESCENDING").limit(1).stream())
        if docs:
            _LATEST_BCV_RATE = float(docs[0].to_dict().get("value"))
            print(f"[BCV] Tasa cargada desde Firestore: Bs {_LATEST_BCV_RATE:,.2f}", flush=True)
            return _LATEST_BCV_RATE
    except Exception as e:
        print(f"[BCV] Error cargando tasa desde Firestore: {e}", flush=True)
    
    # Fallback directly fetching it using urllib
    try:
        import urllib.request
        import json
        url = "https://ve.dolarapi.com/v1/dolares/oficial"
        req = urllib.request.Request(url, headers={"User-Agent": "TrackFlow/1.0"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode())
            rate = data.get("promedio") or data.get("price")
            if rate:
                _LATEST_BCV_RATE = float(rate)
                print(f"[BCV] Tasa obtenida de backup (dolarapi): Bs {_LATEST_BCV_RATE:,.2f}", flush=True)
                return _LATEST_BCV_RATE
    except Exception as e:
        print(f"[BCV] Error cargando backup: {e}", flush=True)

    _LATEST_BCV_RATE = 44.5  # safe hardcoded fallback
    return _LATEST_BCV_RATE


def parse_price_usd(text):
    if not text:
        return None
    cleaned = text.replace("Ref.", "").replace("Ref", "").replace("$", "").replace("USD", "").replace(":", "").strip()
    cleaned = re.sub(r"[^\d.,]", "", cleaned)
    if not cleaned:
        return None
    if "," in cleaned:
        cleaned = cleaned.replace(".", "").replace(",", ".")
    try:
        return float(cleaned)
    except ValueError:
        return None


def is_usd_text(text):
    if not text:
        return False
    t = text.lower()
    return "ref" in t or "$" in t or "usd" in t or "divisa" in t


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
            # Esperar a que el h1, la clase de precio o el texto "Bs" se carguen (lo que ocurra primero)
            # Esto evita esperas secuenciales lentas y optimiza el tiempo de respuesta.
            page.wait_for_selector("h1, .product-purchase__price, [class*='price']", timeout=4000)
        except PlaywrightTimeout:
            pass

        # Desplazamiento sutil para simular actividad del usuario y gatillar hidratación de React/Next.js
        try:
            page.evaluate("window.scrollTo(0, 300)")
            time.sleep(0.4)
            page.evaluate("window.scrollTo(0, 0)")
            time.sleep(0.4)
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
                                document.querySelector('[class*="product-info"]') ||
                                document.querySelector('[class*="productDetails"]') ||
                                document.querySelector('[class*="product-details"]') ||
                                document.querySelector('[class*="vtex-store-components"]');
                
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
                    '[class*="discount"]',
                    '[class*="sellingPriceValue"]',
                    '[class*="sellingPrice"]',
                    '[class*="price-selling"]',
                    '[class*="price_sellingPrice"]',
                    '[class*="PriceValue"]',
                    '[class*="priceValue"]',
                    '[class*="priceFraction"]',
                    '[class*="vtex-product-price"]',
                    '[class*="vtex-store-components-3-x-sellingPrice"]'
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
                    '[class*="list-price"]',
                    '[class*="listPriceValue"]',
                    '[class*="listPrice"]',
                    '[class*="price-list"]',
                    '[class*="price_listPrice"]'
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

                // 7. Encontrar el precio más cercano al H1 (ideal para Locatel, SAAS y fallback general)
                let closestPrice = null;
                let closestRefPrice = null;
                if (h1El) {
                    function getDistance(el1, el2) {
                        const path1 = [];
                        let cur = el1;
                        while (cur) { path1.push(cur); cur = cur.parentElement; }
                        
                        cur = el2;
                        let dist2 = 0;
                        while (cur) {
                            const idx = path1.indexOf(cur);
                            if (idx !== -1) return idx + dist2;
                            dist2++;
                            cur = cur.parentElement;
                        }
                        return 999;
                    }

                    try {
                        const priceElements = Array.from(document.querySelectorAll('*')).filter(el => {
                            if (el.children.length > 0) return false; // solo hojas
                            const t = (el.innerText || el.textContent || '').trim();
                            const t_lower = t.toLowerCase();
                            const hasBs = t_lower.includes('bs') || t_lower.includes('bolivar') || t_lower.includes('ves');
                            return hasBs && /\d+/.test(t);
                        });
                        
                        if (priceElements.length > 0) {
                            let minDist = Infinity;
                            let bestEl = null;
                            priceElements.forEach(el => {
                                const d = getDistance(h1El, el);
                                if (d < minDist) {
                                    minDist = d;
                                    bestEl = el;
                                }
                            });
                            if (bestEl) {
                                closestPrice = (bestEl.innerText || bestEl.textContent || '').trim();
                            }
                        }
                    } catch(e_dist) {}

                    try {
                        const refElements = Array.from(document.querySelectorAll('*')).filter(el => {
                            if (el.children.length > 0) return false;
                            const t = (el.innerText || el.textContent || '').trim();
                            return (t.includes('Ref') || t.includes('$') || t.includes('USD')) && /\d+/.test(t);
                        });
                        if (refElements.length > 0) {
                            let minDist = Infinity;
                            let bestEl = null;
                            refElements.forEach(el => {
                                const d = getDistance(h1El, el);
                                if (d < minDist) {
                                    minDist = d;
                                    bestEl = el;
                                }
                            });
                            if (bestEl) {
                                closestRefPrice = (bestEl.innerText || bestEl.textContent || '').trim();
                            }
                        }
                    } catch(e_ref) {}
                }

                return {
                    active_text: active_text,
                    original_text: original_text,
                    nombre: nombre,
                    block_prices: blockPrices,
                    closest_price: closestPrice,
                    closest_ref_price: closestRefPrice
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
        active_text_raw = data.get("active_text") or ""
        original_text_raw = data.get("original_text") or ""

        precio_activo = parse_price(active_text_raw)
        precio_original = parse_price(original_text_raw)
        precio_closest = parse_price(data.get("closest_price"))
        precio_closest_ref = parse_price_usd(data.get("closest_ref_price"))

        # Validar rangos lógicos para evitar parseos erróneos (como teléfonos, RIFs o ceros)
        if precio_activo is not None and (precio_activo <= 0.1 or precio_activo > 50000.0):
            print(f"   [Filtro Rango] precio_activo inválido ({precio_activo}), descartado.", flush=True)
            precio_activo = None
        if precio_original is not None and (precio_original <= 0.1 or precio_original > 50000.0):
            print(f"   [Filtro Rango] precio_original inválido ({precio_original}), descartado.", flush=True)
            precio_original = None
        if precio_closest is not None and (precio_closest <= 0.1 or precio_closest > 50000.0):
            precio_closest = None
        if precio_closest_ref is not None and (precio_closest_ref <= 0.01 or precio_closest_ref > 1000.0):
            precio_closest_ref = None

        # Determinar si el precio activo o original están en USD
        is_active_usd = is_usd_text(active_text_raw) or (precio_activo is not None and "farmaciasaas" in url.lower() and precio_activo < 20.0)
        is_original_usd = is_usd_text(original_text_raw) or (precio_original is not None and "farmaciasaas" in url.lower() and precio_original < 20.0)

        if is_active_usd:
            # Si el precio activo está en USD, preferimos usar el precio en Bolívares que encontramos en la página.
            if precio_closest is not None:
                print(f"   [Detector Moneda] Se detectó precio activo en USD ({precio_activo}), reemplazando por precio real en Bs. ({precio_closest} Bs.)", flush=True)
                precio_activo = precio_closest
            else:
                # Si no hay precio en Bs, convertimos usando la tasa BCV
                rate = get_latest_bcv_rate()
                precio_activo_bs = round(precio_activo * rate, 2) if precio_activo is not None else None
                print(f"   [Detector Moneda] Se detectó precio activo en USD ({precio_activo}), convirtiendo a Bs usando tasa {rate:,.2f} -> {precio_activo_bs} Bs.", flush=True)
                precio_activo = precio_activo_bs

        if is_original_usd and precio_original is not None:
            # Si el precio original está en USD, lo convertimos a Bolívares usando la tasa BCV
            rate = get_latest_bcv_rate()
            precio_original = round(precio_original * rate, 2)

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

        # Si aún es None, usamos el precio más cercano al H1
        if precio_activo is None and precio_closest is not None:
            precio_activo = precio_closest

        # Si aún es None, probamos a convertir el precio de referencia USD a Bolívares!
        if precio_activo is None and precio_closest_ref is not None:
            rate = get_latest_bcv_rate()
            precio_activo = round(precio_closest_ref * rate, 2)
            print(f"      [Conversor] Convertido precio USD {precio_closest_ref} a Bs. {precio_activo} usando tasa {rate:,.2f}", flush=True)

        # Re-validar precio activo tras las conversiones y herencias
        if precio_activo is not None and (precio_activo <= 0.1 or precio_activo > 50000.0):
            print(f"   [Filtro Rango Final] precio_activo resultante inválido ({precio_activo}), descartado.", flush=True)
            precio_activo = None
        if precio_original is not None and (precio_original <= 0.1 or precio_original > 50000.0):
            precio_original = None

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


def get_search_query_from_url(url):
    if not url:
        return ""
    if "/producto/" in url:
        path_part = url.split("/producto/")[-1].split("?")[0].split("#")[0]
        clean_part = re.sub(r'^\d+-', '', path_part)
        query = clean_part.replace("-", " ").strip()
        return query
    elif "/p" in url:
        # Locatel style: https://www.locatel.com.ve/calox_acetaminofen_650mg_x_10_tabletas/p
        # SAAS style: https://www.farmaciasaas.com/11497-cetirizina-comp-10mg-x10-leti/p
        parts = [p for p in url.split("/") if p]
        if len(parts) >= 2:
            slug = parts[-2]
            clean_part = re.sub(r'^\d+-', '', slug)
            query = clean_part.replace("_", " ").replace("-", " ").strip()
            return query
    return ""


def search_farmatodo_product_url(page, query_text):
    if not query_text:
        return None
    
    import urllib.parse
    encoded_query = urllib.parse.quote(query_text)
    search_url = f"https://www.farmatodo.com.ve/buscar/{encoded_query}"
    print(f"      [Buscador] Navegando a la página de búsqueda: {search_url}", flush=True)
    
    try:
        # Cargamos la página
        page.goto(search_url, wait_until="domcontentloaded", timeout=40000)
        time.sleep(5.0)  # Esperar para hidratación
        
        # Desplazarse un poco para gatillar renderizado/carga de imágenes/tarjetas
        page.evaluate("window.scrollTo(0, 400)")
        time.sleep(1.0)
        page.evaluate("window.scrollTo(0, 0)")
        time.sleep(1.0)
        
        # Encontrar enlaces de productos en los resultados de búsqueda
        links_data = page.evaluate("""
            () => {
                const links = Array.from(document.querySelectorAll('a'));
                const results = [];
                for (const link of links) {
                    const href = link.getAttribute('href') || '';
                    if (href.includes('/producto/')) {
                        const text = (link.innerText || link.textContent || '').trim().replace(/\\n/g, ' ');
                        results.push({ href: href, text: text });
                    }
                }
                return results;
            }
        """)
        
        if not links_data:
            print("      [Buscador] No se encontraron enlaces de producto en los resultados.", flush=True)
            return None
        
        # Convertir hrefs relativos a absolutos y de-duplicar
        seen_hrefs = set()
        unique_links = []
        for l in links_data:
            href = l["href"]
            if href.startswith("/"):
                href = "https://www.farmatodo.com.ve" + href
            if href not in seen_hrefs:
                seen_hrefs.add(href)
                unique_links.append({"href": href, "text": l["text"]})
        
        # Filtrar las palabras clave para encontrar la mejor coincidencia
        keywords = [w.lower() for w in query_text.split() if len(w) > 2]
        
        best_url = None
        for link in unique_links[:5]:  # Evaluar los primeros 5 resultados
            href_lower = link["href"].lower()
            text_lower = link["text"].lower()
            
            # Contar coincidencias
            matches = sum(1 for kw in keywords if kw in href_lower or kw in text_lower)
            min_matches = max(1, min(len(keywords) // 2, 2))
            if matches >= min_matches:
                best_url = link["href"]
                print(f"      [Buscador] Encontrado producto que coincide: {best_url} (coincidió {matches} palabras clave)", flush=True)
                break
                
        if not best_url and unique_links:
            best_url = unique_links[0]["href"]
            print(f"      [Buscador] Fallback al primer resultado de la lista: {best_url}", flush=True)
            
        return best_url
    except Exception as e:
        print(f"      [Buscador] Error buscando '{query_text}': {e}", flush=True)
        return None


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

        if cadena_norm in ("farmatodo", "locatel", "farmaciasaas", "saas", "farmacias saas", "farmacia saas"):
            filas_farmatodo.append(fila)
        else:
            filas_otras_cadenas.append(fila)

    # FILTRADO ADICIONAL POR VARIABLE DE ENTORNO (SCRAPING INDIVIDUAL)
    import os
    only_product_id = os.environ.get("ONLY_PRODUCT_ID")
    only_doc_id = os.environ.get("ONLY_DOC_ID")

    if only_product_id:
        only_product_id = only_product_id.strip()
        filas_farmatodo = [f for f in filas_farmatodo if f.get("id_producto_propio") == only_product_id]
        print(f"[FILTRO INDIVIDUAL] Filtrando por ONLY_PRODUCT_ID={only_product_id}. Quedan {len(filas_farmatodo)} filas para este scraping.", flush=True)

    if only_doc_id:
        only_doc_id = only_doc_id.strip()
        filas_farmatodo = [f for f in filas_farmatodo if f.get("_doc_id") == only_doc_id]
        print(f"[FILTRO INDIVIDUAL] Filtrando por ONLY_DOC_ID={only_doc_id}. Quedan {len(filas_farmatodo)} filas para este scraping.", flush=True)

    print("")
    print("=" * 60)
    print("RESUMEN DE FILAS:")
    print("  Total en fuente:        " + str(len(filas_todas)))
    print("  Activas (Farmatodo/Locatel/SAAS): " + str(len(filas_farmatodo)))
    print("  De otras cadenas:       " + str(len(filas_otras_cadenas))
          + " (ignoradas, scraper no implementado)")
    print("  Inactivas:              " + str(len(filas_inactivas)))
    print("=" * 60)

    if filas_otras_cadenas:
        print("")
        print("Cadenas detectadas no soportadas:")
        cadenas_unicas = set(str(f.get("cadena", "")) for f in filas_otras_cadenas)
        for c in cadenas_unicas:
            cnt = sum(1 for f in filas_otras_cadenas if str(f.get("cadena", "")) == c)
            print("  - " + str(c) + ": " + str(cnt) + " URLs")
        print("")

    if not filas_farmatodo:
        print("No hay URLs activas de Farmatodo/Locatel/SAAS para scrapear.")
        sys.exit(0)

    # PARALELISMO SEGURO: Dividir el scraping en hilos concurrentes (máximo 6)
    NUM_THREADS = 6
    chunks = [filas_farmatodo[i::NUM_THREADS] for i in range(NUM_THREADS)]
    chunks = [c for c in chunks if c]  # Filtrar grupos vacíos

    print("")
    print(f"Scrapeando {len(filas_farmatodo)} URLs usando {len(chunks)} hilos concurrentes...")
    print("")
    inicio = time.time()
    resultados = []

    def scrape_worker(thread_id, chunk_filas):
        if not chunk_filas:
            return []
        
        # Inicio escalonado para no saturar al servidor al mismo tiempo
        delay = (thread_id - 1) * 2.5
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
                
                # Bloquear recursos pesados no textuales y hojas de estilo (CSS)
                if res_type in ("image", "media", "font", "websocket", "stylesheet"):
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
                    sleep_time = random.uniform(1.2, 2.5)
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
                r["cadena"] = fila.get("cadena", "Farmatodo")
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

    # SEGUNDO PASO: Reintento secuencial inteligente y fallback de búsqueda para los que fallaron
    failed_results = [r for r in resultados if r.get("error")]
    if failed_results:
        print("", flush=True)
        print("=" * 60, flush=True)
        print(f"[SEGUNDO PASO] Reintentando {len(failed_results)} productos que fallaron...", flush=True)
        print("=" * 60, flush=True)
        print("", flush=True)
        
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
            
            context.add_init_script("""
                Object.defineProperty(navigator, 'webdriver', {
                    get: () => undefined
                });
            """)
            
            page = context.new_page()
            
            def block_unnecessary(route):
                req = route.request
                res_type = req.resource_type
                url_lower = req.url.lower()
                if res_type in ("image", "media", "font", "websocket", "stylesheet"):
                    route.abort()
                    return
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
            
            print("[Segundo Paso] Calentando sesión y ubicando (Caracas)...", flush=True)
            try:
                page.goto("https://www.farmatodo.com.ve", wait_until="domcontentloaded", timeout=35000)
                time.sleep(4.0)
                page.evaluate("""
                    () => {
                        const elements = Array.from(document.querySelectorAll('button, a, div, span'));
                        const caracasBtn = elements.find(b => {
                            const t = (b.textContent || '').trim().toLowerCase();
                            return t === 'caracas' || t === 'caracas metropolitana';
                        });
                        if (caracasBtn) {
                            caracasBtn.click();
                            return;
                        }
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
                        }
                    }
                """)
                time.sleep(1.5)
            except Exception as e:
                print(f"[Segundo Paso] Advertencia calentando sesión: {e}", flush=True)
                
            for idx, r_old in enumerate(failed_results, 1):
                marca = r_old.get("marca") or "?"
                tipo = r_old.get("tipo") or "?"
                url_orig = r_old.get("url") or ""
                id_prod = r_old.get("id_producto_propio") or ""
                
                print(f"[Segundo Paso] [{idx}/{len(failed_results)}] Reintentando {marca} ({tipo}) - {id_prod}", flush=True)
                
                # Reintento directo con un poco de espera
                time.sleep(random.uniform(2.0, 4.0))
                r_new = None
                if url_orig:
                    try:
                        print(f"   [Directo] Probando URL original de nuevo: {url_orig}", flush=True)
                        r_new = scrape_url(page, url_orig, marca, thread_id="SP")
                    except Exception as e:
                        print(f"   [Directo] Error: {e}", flush=True)
                        
                # Fallback al buscador si falló directo o si dice "Producto no disponible o enlace roto"
                if not r_new or r_new.get("error"):
                    query_text = get_search_query_from_url(url_orig)
                    if not query_text:
                        query_text = f"{marca}"
                        
                    print(f"   [Buscador] Directo fallido o agotado ({r_new.get('error') if r_new else 'No response'}). Buscando alternativo: '{query_text}'", flush=True)
                    
                    if "farmatodo" in url_orig.lower():
                        search_url_found = search_farmatodo_product_url(page, query_text)
                    else:
                        search_url_found = None
                        
                    if search_url_found:
                        print(f"   [Buscador] Enlace alternativo encontrado: {search_url_found}. Raspando...", flush=True)
                        try:
                            time.sleep(2.0)
                            r_new = scrape_url(page, search_url_found, marca, thread_id="SP")
                            if r_new and not r_new.get("error"):
                                r_new["url"] = search_url_found  # Guardar la nueva URL para actualizarla en Firestore
                                print(f"   [Buscador] ¡ÉXITO! Producto resuelto y URL actualizada.", flush=True)
                        except Exception as e:
                            print(f"   [Buscador] Error: {e}", flush=True)
                            
                # Reemplazar en la lista de resultados original si el reintento tuvo éxito
                if r_new and not r_new.get("error"):
                    r_new["id_producto_propio"] = id_prod
                    r_new["cadena"] = r_old.get("cadena", "Farmatodo")
                    r_new["tipo"] = tipo
                    r_new["_doc_id"] = r_old.get("_doc_id")
                    r_new["laboratorio"] = r_old.get("laboratorio")
                    
                    for i, temp_r in enumerate(resultados):
                        if temp_r.get("_doc_id") == r_old.get("_doc_id") or (temp_r.get("id_producto_propio") == id_prod and temp_r.get("marca") == r_old.get("marca") and temp_r.get("tipo") == tipo):
                            resultados[i] = r_new
                            print(f"   [Segundo Paso] Resultado de {marca} actualizado con éxito en la lista final.", flush=True)
                            break
                else:
                    print(f"   [Segundo Paso] No se pudo recuperar el producto {marca}.", flush=True)
                    
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
