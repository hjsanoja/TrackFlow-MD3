# Sube los resultados del scraper (resultados.json) a Firestore optimizando escrituras en lote (Delta Sync).

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from firebase_client import get_db
from firebase_admin import firestore


PROJECT_ROOT = Path(__file__).parent.parent
RESULTS_PATH = PROJECT_ROOT / "resultados.json"
CACHE_PATH = PROJECT_ROOT / "cache_precios_previos.json"


def detectar_trigger():
    event = os.environ.get("GITHUB_EVENT_NAME")
    if event == "schedule":
        return "scheduled"
    if event == "workflow_dispatch":
        return "manual_github"
    if event == "repository_dispatch":
        return "manual_panel"
    return "manual_local"


def main():
    if not RESULTS_PATH.exists():
        print("ERROR: no encuentro " + str(RESULTS_PATH))
        sys.exit(1)

    with open(RESULTS_PATH, encoding="utf-8") as f:
        resultados = json.load(f)

    if not resultados:
        print("resultados.json esta vacio.")
        sys.exit(0)

    db = get_db()
    print("Analizando " + str(len(resultados)) + " resultados para sincronización en Firestore...")

    # Cargar caché local para comparación de cambios (Delta Sync)
    cache_previo = {}
    if CACHE_PATH.exists():
        try:
            cache_previo = json.loads(CACHE_PATH.read_text(encoding="utf-8"))
        except Exception:
            cache_previo = {}

    ahora = datetime.now(timezone.utc)
    run_id = ahora.strftime("%Y%m%d_%H%M%S")
    trigger = detectar_trigger()
    ok = 0
    errores = 0

    batch = db.batch()
    batch_count = 0
    total_escritos = 0
    ahorrados = 0

    nuevo_cache = {}

    for r in resultados:
        prod_comp_id = r.get("_doc_id")
        if not prod_comp_id:
            laboratorio = r.get("laboratorio", "")
            parts = [str(r.get("id_producto_propio", "")), str(r.get("cadena", "")), str(r.get("marca", ""))]
            if laboratorio:
                parts.append(str(laboratorio))
            prod_comp_id = "_".join(parts).replace(" ", "_").replace("/", "_").replace("\\", "_")

        es_error = False
        error_msg = ""
        if r.get("error"):
            es_error = True
            error_msg = r["error"]
        elif r.get("precio_full_bs") is None or r.get("precio_full_bs") <= 0.1:
            es_error = True
            error_msg = "Precio no encontrado en la página (agotado o sin precio visible)."

        if es_error:
            errores += 1
        else:
            ok += 1

        p_full = r.get("precio_full_bs")
        p_desc = r.get("precio_desc_bs")
        estado_str = "error" if es_error else "ok"

        # Clave y estado para comparar cambios respecto a la última corrida
        estado_actual = f"{estado_str}|{p_full}|{p_desc}|{error_msg}"
        nuevo_cache[prod_comp_id] = {
            "estado": estado_actual,
            "precio_full_bs": p_full,
            "precio_desc_bs": p_desc,
            "error": error_msg
        }

        estado_previo = cache_previo.get(prod_comp_id, {}).get("estado")

        # Si el estado y precios son idénticos a los anteriores, omitimos escritura individual para ahorrar cuota
        if estado_actual == estado_previo:
            ahorrados += 1
            continue

        ref_doc = db.collection("productos_competencia").document(prod_comp_id)

        if es_error:
            batch.set(ref_doc, {
                "id_producto_propio": r.get("id_producto_propio"),
                "cadena": r.get("cadena"),
                "marca": r.get("marca"),
                "tipo": r.get("tipo"),
                "url": r.get("url"),
                "ultimo_scrape": ahora,
                "estado": "error",
                "ultimo_error": error_msg,
            }, merge=True)
        else:
            # 1. Registro de histórico si hubo cambio de precio
            historico_ref = db.collection("historico_precios").document()
            batch.set(historico_ref, {
                "prod_comp_id": prod_comp_id,
                "id_producto_propio": r.get("id_producto_propio"),
                "cadena": r.get("cadena"),
                "marca": r.get("marca"),
                "tipo": r.get("tipo"),
                "nombre": r.get("nombre"),
                "precio_full_bs": p_full,
                "precio_desc_bs": p_desc,
                "tiene_descuento": r.get("tiene_descuento", False),
                "scraped_at": ahora,
                "run_id": run_id,
            })
            batch_count += 1

            # 2. Actualización de documento en productos_competencia
            batch.set(ref_doc, {
                "id_producto_propio": r.get("id_producto_propio"),
                "cadena": r.get("cadena"),
                "marca": r.get("marca"),
                "tipo": r.get("tipo"),
                "url": r.get("url"),
                "ultimo_scrape": ahora,
                "ultimo_precio_full_bs": p_full,
                "ultimo_precio_desc_bs": p_desc,
                "ultimo_nombre": r.get("nombre"),
                "estado": "ok",
                "actualizado_manualmente": firestore.DELETE_FIELD,
            }, merge=True)

        batch_count += 1
        total_escritos += 1

        # Enviar lote a Firestore cuando alcance 400 operaciones (límite máximo de Firestore es 500)
        if batch_count >= 400:
            batch.commit()
            batch = db.batch()
            batch_count = 0

    if batch_count > 0:
        batch.commit()

    # Guardar resumen de ejecución para el Dashboard UI
    run_ref = db.collection("scrape_runs").document(run_id)
    run_ref.set({
        "run_id": run_id,
        "started_at": ahora,
        "total": len(resultados),
        "ok": ok,
        "errores": errores,
        "trigger": trigger,
    })

    # Actualizar caché local en disco
    try:
        CACHE_PATH.write_text(json.dumps(nuevo_cache, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception as e:
        print(f"[CACHE] Error al escribir cache: {e}")

    print("\n" + "=" * 60)
    print(f"Sincronización completada | Total: {len(resultados)} | OK: {ok} | Errores: {errores}")
    print(f"Escrituras realizadas: {total_escritos} | Escrituras ahorradas en cuota gratuita: {ahorrados}")
    print("Trigger: " + trigger)
    print("Run ID: " + run_id)
    print("=" * 60)


if __name__ == "__main__":
    main()
