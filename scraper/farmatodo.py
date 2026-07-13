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
    cleaned = re.sub(r"[^\d.]", "", text.replace("Bs.", "").replace("Bs", ""))
    if not cleaned:
        return None
    if cleaned.count(".") > 1:
        parts = cleaned.split(".")
        cleaned = "".join(parts[:-1]) + "." + parts[-1]
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

    try:
        print("   Cargando...", flush=True)
        try:
            response = page.goto(url, wait_until="domcontentloaded", timeout=30000)
            if response and response.status >= 400:
                result["error"] = "HTTP " + str(response.status)
                return result
        except PlaywrightTimeout:
            result["error"] = "Timeout cargando la pagina"
            return result

        print("   Esperando contenido...", flush=True)
        try:
            page.wait_for_load_state("networkidle", timeout=15000)
        except PlaywrightTimeout:
            pass
        time.sleep(2)

        print("   Extrayendo datos...", flush=True)
        data = page.evaluate("""
            () => {
                const active = document.querySelector('span.product-purchase__price--active');
                const original = document.querySelector('del.product-purchase__price--original');
                const h1 = document.querySelector('h1');
                return {
                    active_text: active ? (active.innerText || active.textContent || '').trim() : null,
                    original_text: original ? (original.innerText || original.textContent || '').trim() : null,
                    nombre: h1 ? (h1.innerText || h1.textContent || '').trim() : null,
                };
            }
        """)

        result["nombre"] = data.get("nombre")
        precio_activo = parse_price(data.get("active_text"))
        precio_original = parse_price(data.get("original_text"))

        if precio_original is not None and precio_activo is not None:
            result["precio_full_bs"] = precio_original
            result["precio_desc_bs"] = precio_activo
            result["tiene_descuento"] = True
        elif precio_activo is not None:
            result["precio_full_bs"] = precio_activo
        else:
            result["error"] = "Precio no encontrado en la pagina"

    except PlaywrightTimeout as e:
        result["error"] = "Timeout: " + str(e)
    except Exception as e:
        result["error"] = type(e).__name__ + ": " + str(e)

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
