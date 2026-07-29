# Sube los resultados del scraper (resultados.json) a Supabase (y Firestore) optimizando escrituras en lote (Delta Sync).

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path


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

    print(f"Analizando {len(resultados)} resultados para sincronización en la Base de Datos...")

    # Cargar caché local para comparación de cambios (Delta Sync)
    cache_previo = {}
    if CACHE_PATH.exists():
        try:
            cache_previo = json.loads(CACHE_PATH.read_text(encoding="utf-8"))
        except Exception:
            cache_previo = {}

    ahora = datetime.now(timezone.utc)
    ahora_iso = ahora.isoformat()
    run_id = ahora.strftime("%Y%m%d_%H%M%S")
    trigger = detectar_trigger()
    ok = 0
    errores = 0

    nuevo_cache = {}
    cambios = []
    historico_items = []

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

        estado_actual = f"{estado_str}|{p_full}|{p_desc}|{error_msg}"
        nuevo_cache[prod_comp_id] = {
            "estado": estado_actual,
            "precio_full_bs": p_full,
            "precio_desc_bs": p_desc,
            "error": error_msg
        }

        estado_previo = cache_previo.get(prod_comp_id, {}).get("estado")

        # Registro para cambio
        item_data = {
            "id": prod_comp_id,
            "_doc_id": prod_comp_id,
            "id_producto_propio": r.get("id_producto_propio"),
            "cadena": r.get("cadena"),
            "marca": r.get("marca"),
            "tipo": r.get("tipo"),
            "url": r.get("url"),
            "ultimo_scrape": ahora_iso,
            "estado": estado_str,
            "ultimo_error": error_msg if es_error else None,
            "precio_full_bs": p_full,
            "precio_desc_bs": p_desc,
            "ultimo_precio_full_bs": p_full,
            "ultimo_precio_desc_bs": p_desc,
            "ultimo_nombre": r.get("nombre"),
            "tiene_descuento": r.get("tiene_descuento", False)
        }
        
        if estado_actual != estado_previo:
            cambios.append((item_data, es_error, r))
            if not es_error:
                historico_items.append({
                    "prod_comp_id": prod_comp_id,
                    "id_producto_propio": r.get("id_producto_propio"),
                    "cadena": r.get("cadena"),
                    "marca": r.get("marca"),
                    "tipo": r.get("tipo"),
                    "nombre": r.get("nombre"),
                    "precio_full_bs": p_full,
                    "precio_desc_bs": p_desc,
                    "tiene_descuento": r.get("tiene_descuento", False),
                    "scraped_at": ahora_iso,
                    "run_id": run_id
                })

    # 1. SINCRONIZAR A SUPABASE SI ESTÁ CONFIGURADO
    try:
        from supabase_client import is_supabase_configured, upsert, insert
        if is_supabase_configured():
            print("\n[SUPABASE] Sincronizando datos con Supabase...")
            
            # Upsert en productos_competencia
            records_to_upsert = [item[0] for item in cambios]
            if records_to_upsert:
                # Insertar en lotes de 100
                for i in range(0, len(records_to_upsert), 100):
                    upsert("productos_competencia", records_to_upsert[i:i+100])
                print(f"[SUPABASE] ✅ Actualizados {len(records_to_upsert)} productos en productos_competencia.")

            # Insertar en historico_precios
            if historico_items:
                for i in range(0, len(historico_items), 100):
                    insert("historico_precios", historico_items[i:i+100])
                print(f"[SUPABASE] ✅ Insertados {len(historico_items)} registros en historico_precios.")

            # Registrar scrape_run
            run_data = [{
                "run_id": run_id,
                "started_at": ahora_iso,
                "total": len(resultados),
                "ok": ok,
                "errores": errores,
                "trigger": trigger
            }]
            insert("scrape_runs", run_data)
            print(f"[SUPABASE] ✅ Registrado scrape_run ID: {run_id}")

    except Exception as e:
        print(f"[SUPABASE] Aviso: No se pudo completar la sincronización ({e})")

    # 2. SINCRONIZAR A FIRESTORE SI ESTÁ DISPONIBLE
    try:
        from firebase_client import get_db
        from firebase_admin import firestore
        db = get_db()
        print("\n[FIRESTORE] Sincronizando datos con Firestore...")
        batch = db.batch()
        batch_count = 0

        for item_data, es_error, r in cambios:
            ref_doc = db.collection("productos_competencia").document(item_data["_doc_id"])
            if es_error:
                batch.set(ref_doc, {
                    "id_producto_propio": r.get("id_producto_propio"),
                    "cadena": r.get("cadena"),
                    "marca": r.get("marca"),
                    "tipo": r.get("tipo"),
                    "url": r.get("url"),
                    "ultimo_scrape": ahora,
                    "estado": "error",
                    "ultimo_error": item_data["ultimo_error"],
                }, merge=True)
            else:
                historico_ref = db.collection("historico_precios").document()
                batch.set(historico_ref, {
                    "prod_comp_id": item_data["_doc_id"],
                    "id_producto_propio": r.get("id_producto_propio"),
                    "cadena": r.get("cadena"),
                    "marca": r.get("marca"),
                    "tipo": r.get("tipo"),
                    "nombre": r.get("nombre"),
                    "precio_full_bs": item_data["precio_full_bs"],
                    "precio_desc_bs": item_data["precio_desc_bs"],
                    "tiene_descuento": r.get("tiene_descuento", False),
                    "scraped_at": ahora,
                    "run_id": run_id,
                })
                batch_count += 1

                batch.set(ref_doc, {
                    "id_producto_propio": r.get("id_producto_propio"),
                    "cadena": r.get("cadena"),
                    "marca": r.get("marca"),
                    "tipo": r.get("tipo"),
                    "url": r.get("url"),
                    "ultimo_scrape": ahora,
                    "ultimo_precio_full_bs": item_data["precio_full_bs"],
                    "ultimo_precio_desc_bs": item_data["precio_desc_bs"],
                    "ultimo_nombre": r.get("nombre"),
                    "estado": "ok",
                    "actualizado_manualmente": firestore.DELETE_FIELD,
                }, merge=True)

            batch_count += 1
            if batch_count >= 400:
                batch.commit()
                batch = db.batch()
                batch_count = 0

        if batch_count > 0:
            batch.commit()

        run_ref = db.collection("scrape_runs").document(run_id)
        run_ref.set({
            "run_id": run_id,
            "started_at": ahora,
            "total": len(resultados),
            "ok": ok,
            "errores": errores,
            "trigger": trigger,
        })
        print("[FIRESTORE] ✅ Sincronización con Firestore finalizada.")
    except Exception as e:
        print(f"[FIRESTORE] Aviso: Omitido o no configurado ({e})")

    # Actualizar caché local en disco
    try:
        CACHE_PATH.write_text(json.dumps(nuevo_cache, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception as e:
        print(f"[CACHE] Error al escribir cache: {e}")

    print("\n" + "=" * 60)
    print(f"Sincronización completada | Total: {len(resultados)} | OK: {ok} | Errores: {errores}")
    print(f"Cambios procesados: {len(cambios)} | Ahorrados por delta: {len(resultados) - len(cambios)}")
    print("Trigger: " + trigger)
    print("Run ID: " + run_id)
    print("=" * 60)


if __name__ == "__main__":
    main()
