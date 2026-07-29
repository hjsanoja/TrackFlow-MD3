"""
Script de migración de datos de Firestore a Supabase.
Copia todas las colecciones principales de Firestore (productos, cadenas, productos_competencia,
usuarios, bcv_rates, historico_precios, scrape_runs) hacia la base de datos de Supabase.

Requisitos:
Variables de entorno configuradas:
  - VITE_SUPABASE_URL (o SUPABASE_URL)
  - SUPABASE_SERVICE_ROLE_KEY (o SUPABASE_KEY / VITE_SUPABASE_ANON_KEY)
  - Credenciales/Proyecto Firebase
"""

import sys
import os
from pathlib import Path

# Añadir el directorio scraper al sys.path
sys.path.insert(0, str(Path(__file__).parent))

from firebase_client import get_db
from supabase_client import is_supabase_configured, upsert, insert, select

def migrar_coleccion(nombre_tabla: str, doc_id_key: str = "id"):
    print(f"\n--- Migrando colección '{nombre_tabla}' ---")
    db = get_db()
    try:
        docs = db.collection(nombre_tabla).stream()
        registros = []
        for doc in docs:
            data = doc.to_dict() or {}
            # Guardar el ID del documento
            data["_doc_id"] = doc.id
            if doc_id_key and doc_id_key not in data:
                data[doc_id_key] = doc.id
            
            # Convertir timestamps de Firestore a ISO string
            for key, val in data.items():
                if hasattr(val, "isoformat"):
                    data[key] = val.isoformat()
            
            registros.append(data)
        
        if not registros:
            print(f"La colección '{nombre_tabla}' en Firestore está vacía o no existe.")
            return

        print(f"Obtenidos {len(registros)} registros de Firestore. Insertando/Actualizando en Supabase...")
        
        # Enviar en lotes de 100
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
                # Intentar fila por fila si un lote falla por esquema
                for item in lote:
                    try:
                        upsert(nombre_tabla, [item])
                    except Exception as single_err:
                        print(f"    Error en item {item.get('id', 'desconocido')}: {single_err}")

        print(f"✅ Colección '{nombre_tabla}' migrada con éxito ({total_migrados} registros).")
    except Exception as e:
        print(f"Error migrando '{nombre_tabla}': {e}")

def main():
    if not is_supabase_configured():
        print("ERROR: Supabase no está configurado en las variables de entorno.")
        print("Asegúrate de definir VITE_SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY.")
        sys.exit(1)

    print("Iniciando migración completa desde Firestore hacia Supabase...")
    
    colecciones = [
        ("cadenas", "id"),
        ("productos", "id"),
        ("productos_competencia", "id"),
        ("usuarios", "id"),
        ("bcv_rates", "id"),
        ("scrape_runs", "run_id"),
        ("historico_precios", "id")
    ]

    for tabla, key in colecciones:
        migrar_coleccion(tabla, key)

    print("\n=========================================")
    print("✨ ¡Migración finalizada exitosamente! ✨")
    print("=========================================")

if __name__ == "__main__":
    main()
