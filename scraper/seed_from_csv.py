# Carga inicial: lee los 4 CSVs y los sube a Firestore.
# Tolerante a encoding: intenta UTF-8, UTF-8-BOM, CP1252 y Latin-1.

import csv
import io
import sys
from pathlib import Path

from firebase_client import get_db


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


def seed_productos(db):
    rows = read_csv(PROJECT_ROOT / "productos.csv")
    print("productos: " + str(len(rows)) + " filas")
    for row in rows:
        doc_id = row["id_interno"].strip()
        db.collection("productos").document(doc_id).set({
            "id_interno": doc_id,
            "nombre": row.get("nombre", "").strip(),
            "laboratorio": row.get("laboratorio", "").strip(),
            "principio_activo": row.get("principio_activo", "").strip(),
            "presentacion": row.get("presentacion", "").strip(),
            "categoria": row.get("categoria", "").strip(),
            "pvp_propio_usd": parse_float(row.get("pvp_propio_usd")),
            "activo": es_si(row.get("activo", "")),
        })


def seed_cadenas(db):
    rows = read_csv(PROJECT_ROOT / "cadenas.csv")
    print("cadenas: " + str(len(rows)) + " filas")
    for row in rows:
        doc_id = row["nombre"].strip().replace(" ", "_")
        db.collection("cadenas").document(doc_id).set({
            "nombre": row.get("nombre", "").strip(),
            "website": row.get("website", "").strip(),
            "scraper_modulo": row.get("scraper_modulo", "").strip(),
            "activo": es_si(row.get("activo", "")),
        })


def seed_productos_competencia(db):
    rows = read_csv(PROJECT_ROOT / "productos_competencia.csv")
    print("productos_competencia: " + str(len(rows)) + " filas")
    for row in rows:
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

        db.collection("productos_competencia").document(doc_id).set({
            "id_producto_propio": prod_id,
            "cadena": cadena,
            "tipo": row.get("tipo", "").strip(),
            "marca": marca,
            "url": row.get("url", "").strip(),
            "activo": es_si(row.get("activo", "")),
            "laboratorio": laboratorio,
            "concentracion": concentracion,
            "tamano": tamano,
        }, merge=True)


def seed_usuarios(db):
    rows = read_csv(PROJECT_ROOT / "usuarios.csv")
    print("usuarios: " + str(len(rows)) + " filas")
    for row in rows:
        email = row["email"].strip().lower()
        doc_id = email.replace("@", "_at_").replace(".", "_")
        db.collection("usuarios").document(doc_id).set({
            "email": email,
            "nombre": row.get("nombre", "").strip(),
            "rol": row.get("rol", "").strip().lower(),
            "recibe_alertas_inmediatas": es_si(row.get("recibe_alertas_inmediatas", "")),
            "recibe_resumen_diario": es_si(row.get("recibe_resumen_diario", "")),
            "activo": es_si(row.get("activo", "")),
        })


def main():
    db = get_db()
    print("Cargando datos a Firestore...")
    print("")
    seed_productos(db)
    seed_cadenas(db)
    seed_productos_competencia(db)
    seed_usuarios(db)
    print("")
    print("Carga completa.")


if __name__ == "__main__":
    main()
