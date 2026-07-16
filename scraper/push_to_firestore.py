# Sube los resultados del scraper (resultados.json) a Firestore.

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from firebase_client import get_db
from firebase_admin import firestore


PROJECT_ROOT = Path(__file__).parent.parent
RESULTS_PATH = PROJECT_ROOT / "resultados.json"


def detectar_trigger():
    # Si lo corre GitHub Actions, hay variables de entorno especiales
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
    print("Subiendo " + str(len(resultados)) + " resultados a Firestore...")

    ahora = datetime.now(timezone.utc)
    run_id = ahora.strftime("%Y%m%d_%H%M%S")
    trigger = detectar_trigger()
    ok = 0
    errores = 0

    for r in resultados:
        prod_comp_id = r.get("_doc_id")
        if not prod_comp_id:
            laboratorio = r.get("laboratorio", "")
            parts = [r["id_producto_propio"], r["cadena"], r["marca"]]
            if laboratorio:
                parts.append(laboratorio)
            prod_comp_id = "_".join(parts).replace(" ", "_")

        # Considerar error si viene campo 'error' explícito o si no tiene precio válido (es None o <= 0.1)
        es_error = False
        error_msg = ""
        if r.get("error"):
            es_error = True
            error_msg = r["error"]
        elif r.get("precio_full_bs") is None or r.get("precio_full_bs") <= 0.1:
            es_error = True
            error_msg = "Precio no encontrado en la página (agotado o sin precio visible)."

        if es_error:
            print("  Skip " + r["marca"] + ": " + error_msg)
            errores += 1
            db.collection("productos_competencia").document(prod_comp_id).set({
                "id_producto_propio": r["id_producto_propio"],
                "cadena": r["cadena"],
                "marca": r["marca"],
                "tipo": r["tipo"],
                "url": r["url"],
                "ultimo_scrape": ahora,
                "estado": "error",
                "ultimo_error": error_msg,
            }, merge=True)
            continue

        historico_doc = {
            "prod_comp_id": prod_comp_id,
            "id_producto_propio": r["id_producto_propio"],
            "cadena": r["cadena"],
            "marca": r["marca"],
            "tipo": r["tipo"],
            "nombre": r["nombre"],
            "precio_full_bs": r["precio_full_bs"],
            "precio_desc_bs": r["precio_desc_bs"],
            "tiene_descuento": r["tiene_descuento"],
            "scraped_at": ahora,
            "run_id": run_id,
        }
        db.collection("historico_precios").add(historico_doc)

        db.collection("productos_competencia").document(prod_comp_id).set({
            "id_producto_propio": r["id_producto_propio"],
            "cadena": r["cadena"],
            "marca": r["marca"],
            "tipo": r["tipo"],
            "url": r["url"],
            "ultimo_scrape": ahora,
            "ultimo_precio_full_bs": r["precio_full_bs"],
            "ultimo_precio_desc_bs": r["precio_desc_bs"],
            "ultimo_nombre": r["nombre"],
            "estado": "ok",
            "actualizado_manualmente": firestore.DELETE_FIELD,
        }, merge=True)

        ok += 1
        print("  OK: " + r["marca"] + " -> Bs " + str(r["precio_full_bs"]))

    db.collection("scrape_runs").document(run_id).set({
        "run_id": run_id,
        "started_at": ahora,
        "total": len(resultados),
        "ok": ok,
        "errores": errores,
        "trigger": trigger,
    })

    print("")
    print("Listo: " + str(ok) + " OK, " + str(errores) + " errores")
    print("Trigger: " + trigger)
    print("Run ID: " + run_id)


if __name__ == "__main__":
    main()
