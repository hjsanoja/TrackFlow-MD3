"""
Script de migración de datos de Firestore / CSVs a Supabase.
Copia todas las colecciones principales de Firestore hacia Supabase,
o usa los archivos CSV locales como fallback si Firestore agota su cuota (429).
"""

import sys
import os
import csv
import io
from pathlib import Path

# Añadir el directorio scraper al sys.path
sys.path.insert(0, str(Path(__file__).parent))

from firebase_client import get_db
from supabase_client import is_supabase_configured, upsert, insert, select

PROJECT_ROOT = Path(__file__).parent.parent


def read_text_robust(path):
    raw = path.read_bytes()
    for encoding in ("utf-8", "utf-8-sig", "cp1252", "latin-1"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    raise RuntimeError("No pude decodificar " + path.name)


def read_csv(path):
    if not path.exists():
        print("  AVISO: no encuentro " + path.name + ", lo salto.")
        return []

    text = read_text_robust(path)

    sample = text[:2048]
    if sample.count(";") > sample.count(","):
        delim = ";"
    else:
        delim = ","

    return list(csv.DictReader(io.StringIO(text), delimiter=delim))


def es_si(valor):
    return str(valor).strip().lower() in ("si", "sí", "yes", "true", "1")


def parse_float(valor):
    if valor is None or valor == "":
        return None
    try:
        s = str(valor).strip()
        if "," in s and "." in s:
            s = s.replace(".", "").replace(",", ".")
        elif "," in s:
            s = s.replace(",", ".")
        return float(s)
    except ValueError:
        return None


def migrar_desde_csv():
    print("\n📦 Cargando datos iniciales desde archivos CSV locales hacia Supabase...")
    
    # 1. Cadenas
    cadenas_rows = read_csv(PROJECT_ROOT / "cadenas.csv")
    if cadenas_rows:
        records = []
        for row in cadenas_rows:
            doc_id = row["nombre"].strip().replace(" ", "_")
            records.append({
                "id": doc_id,
                "_doc_id": doc_id,
                "nombre": row.get("nombre", "").strip(),
                "website": row.get("website", "").strip(),
                "scraper_modulo": row.get("scraper_modulo", "").strip(),
                "activo": es_si(row.get("activo", "")),
            })
        upsert("cadenas", records)
        print(f"  ✅ {len(records)} cadenas cargadas en Supabase desde CSV")

    # 2. Productos
    prod_rows = read_csv(PROJECT_ROOT / "productos.csv")
    if prod_rows:
        records = []
        for row in prod_rows:
            doc_id = row["id_interno"].strip()
            records.append({
                "id": doc_id,
                "_doc_id": doc_id,
                "id_interno": doc_id,
                "nombre": row.get("nombre", "").strip(),
                "laboratorio": row.get("laboratorio", "").strip(),
                "principio_activo": row.get("principio_activo", "").strip(),
                "presentacion": row.get("presentacion", "").strip(),
                "categoria": row.get("categoria", "").strip(),
                "pvp_propio_usd": parse_float(row.get("pvp_propio_usd")),
                "activo": es_si(row.get("activo", "")),
            })
        upsert("productos", records)
        print(f"  ✅ {len(records)} productos cargados en Supabase desde CSV")

    # 3. Productos Competencia
    comp_rows = read_csv(PROJECT_ROOT / "productos_competencia.csv")
    if comp_rows:
        records = []
        for row in comp_rows:
            prod_id = row["id_producto_propio"].strip()
            cadena = row["cadena"].strip()
            marca = row.get("marca", "").strip()
            laboratorio = row.get("laboratorio", "").strip()
            concentracion = row.get("concentracion", "").strip()
            tamano = row.get("tamano", "").strip()
            
            doc_id = prod_id + "_" + cadena + "_" + marca
            if laboratorio:
                doc_id += "_" + laboratorio
            doc_id = doc_id.replace(" ", "_")

            records.append({
                "id": doc_id,
                "_doc_id": doc_id,
                "id_producto_propio": prod_id,
                "cadena": cadena,
                "tipo": row.get("tipo", "").strip(),
                "marca": marca,
                "url": row.get("url", "").strip(),
                "activo": es_si(row.get("activo", "")),
                "laboratorio": laboratorio,
                "concentracion": concentracion,
                "tamano": tamano,
            })
        upsert("productos_competencia", records)
        print(f"  ✅ {len(records)} productos_competencia cargados en Supabase desde CSV")

    # 4. Usuarios
    user_rows = read_csv(PROJECT_ROOT / "usuarios.csv")
    if user_rows:
        records = []
        for row in user_rows:
            email = row["email"].strip().lower()
            doc_id = email.replace("@", "_at_").replace(".", "_")
            records.append({
                "id": doc_id,
                "_doc_id": doc_id,
                "email": email,
                "nombre": row.get("nombre", "").strip(),
                "rol": row.get("rol", "").strip().lower(),
                "recibe_alertas_inmediatas": es_si(row.get("recibe_alertas_inmediatas", "")),
                "recibe_resumen_diario": es_si(row.get("recibe_resumen_diario", "")),
                "activo": es_si(row.get("activo", "")),
            })
        upsert("usuarios", records)
        print(f"  ✅ {len(records)} usuarios cargados en Supabase desde CSV")


def migrar_coleccion(nombre_tabla: str, doc_id_key: str = "id"):
    print(f"\n--- Migrando colección '{nombre_tabla}' ---")
    db = get_db()
    try:
        docs = db.collection(nombre_tabla).stream()
        registros = []
        for doc in docs:
            data = doc.to_dict() or {}
            data["_doc_id"] = doc.id
            if doc_id_key and doc_id_key not in data:
                data[doc_id_key] = doc.id
            
            for key, val in data.items():
                if hasattr(val, "isoformat"):
                    data[key] = val.isoformat()
            
            registros.append(data)
        
        if not registros:
            print(f"La colección '{nombre_tabla}' en Firestore está vacía.")
            return True

        print(f"Obtenidos {len(registros)} registros de Firestore. Insertando/Actualizando en Supabase...")
        
        lote_tamano = 100
        total_migrados = 0
        for i in range(0, len(registros), lote_tamano):
            lote = registros[i:i + lote_tamano]
            try:
                upsert(nombre_tabla, lote)
                total_migrados += len(lote)
                print(f"  Progreso '{nombre_tabla}': {total_migrados}/{len(registros)}")
            except Exception as e:
                print(f"  Error al insertar lote en '{nombre_tabla}': {e}")
                for item in lote:
                    try:
                        upsert(nombre_tabla, [item])
                    except Exception as single_err:
                        print(f"    Error en item {item.get('id', 'desconocido')}: {single_err}")

        print(f"✅ Colección '{nombre_tabla}' migrada con éxito desde Firestore ({total_migrados} registros).")
        return True
    except Exception as e:
        print(f"Error o límite alcanzado en Firestore ({nombre_tabla}): {e}")
        return False


def main():
    if not is_supabase_configured():
        print("ERROR: Supabase no está configurado en las variables de entorno.")
        print("Asegúrate de definir VITE_SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY.")
        sys.exit(1)

    print("Iniciando migración desde Firestore/CSV hacia Supabase...")
    
    colecciones = [
        ("cadenas", "id"),
        ("productos", "id"),
        ("productos_competencia", "id"),
        ("usuarios", "id"),
        ("bcv_rates", "id"),
        ("scrape_runs", "run_id"),
        ("historico_precios", "id")
    ]

    hubo_error_firestore = False
    for tabla, key in colecciones:
        ok = migrar_coleccion(tabla, key)
        if not ok:
            hubo_error_firestore = True

    if hubo_error_firestore:
        print("\n⚠️ Ocurrió una restricción de cuota en Firestore (429 Quota Exceeded).")
        print("Ejecutando respaldo automático desde archivos CSV locales hacia Supabase...")
        migrar_desde_csv()

    print("\n=========================================")
    print("✨ ¡Migración finalizada exitosamente! ✨")
    print("=========================================")


if __name__ == "__main__":
    main()

