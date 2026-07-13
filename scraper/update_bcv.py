"""
Obtiene la tasa BCV automaticamente y la guarda en Firestore.

Se ejecuta antes del scraping de precios. Si pydolarve falla, intentamos
otra fuente. Si todo falla, no rompemos: el scraper sigue, solo no actualizamos
la tasa esa corrida.
"""

import sys
from datetime import datetime, timezone
import urllib.request
import urllib.error
import json

from firebase_client import get_db


def fetch_bcv_pydolarve():
    """Intenta pydolarve.org"""
    try:
        url = "https://pydolarve.org/api/v2/dollar?page=bcv"
        req = urllib.request.Request(url, headers={"User-Agent": "TrackFlow/1.0"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode())
            value = data.get("monitors", {}).get("usd", {}).get("price")
            if value and value > 0:
                return float(value)
    except (urllib.error.URLError, json.JSONDecodeError, KeyError) as e:
        print(f"  pydolarve falló: {e}")
    return None


def fetch_bcv_dolarapi():
    """Backup: ve.dolarapi.com"""
    try:
        url = "https://ve.dolarapi.com/v1/dolares/oficial"
        req = urllib.request.Request(url, headers={"User-Agent": "TrackFlow/1.0"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode())
            value = data.get("promedio") or data.get("price")
            if value and value > 0:
                return float(value)
    except (urllib.error.URLError, json.JSONDecodeError, KeyError) as e:
        print(f"  dolarapi falló: {e}")
    return None


def update_bcv_rate():
    """Obtiene la tasa, la guarda en Firestore, devuelve el valor o None."""
    print("Obteniendo tasa BCV...")
    rate = fetch_bcv_pydolarve()
    if rate is None:
        rate = fetch_bcv_dolarapi()

    if rate is None:
        print("  No se pudo obtener tasa de ninguna fuente")
        return None

    print(f"  Tasa BCV: Bs {rate:,.4f} / USD")
    db = get_db()
    db.collection("bcv_rates").add({
        "value": rate,
        "source": "auto",
        "updated_at": datetime.now(timezone.utc),
    })
    return rate


if __name__ == "__main__":
    rate = update_bcv_rate()
    sys.exit(0 if rate else 1)
