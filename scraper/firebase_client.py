"""
Cliente de Firebase compartido.

Lee la credencial desde la variable de entorno FIREBASE_SERVICE_ACCOUNT
(que contiene el JSON completo del service account).

En GitHub Actions y Codespaces esa variable la inyecta el secret
que creamos en Settings.
"""

import json
import os
import sys

import firebase_admin
from firebase_admin import credentials, firestore


_db = None


def get_db():
    """
    Devuelve un cliente Firestore listo para usar.
    La conexión se cachea: si llamas get_db() dos veces, no reconecta.
    """
    global _db
    if _db is not None:
        return _db

    raw = os.environ.get("FIREBASE_SERVICE_ACCOUNT")
    if not raw:
        print(
            "ERROR: la variable de entorno FIREBASE_SERVICE_ACCOUNT no existe.\n"
            "  - En Codespaces: revisa Settings -> Secrets -> Codespaces.\n"
            "  - Si acabas de crear el secret, reinicia el codespace.",
            file=sys.stderr,
        )
        sys.exit(1)

    try:
        service_account_info = json.loads(raw)
    except json.JSONDecodeError as e:
        print(f"ERROR: FIREBASE_SERVICE_ACCOUNT no es JSON válido: {e}", file=sys.stderr)
        sys.exit(1)

    cred = credentials.Certificate(service_account_info)
    if not firebase_admin._apps:
        firebase_admin.initialize_app(cred)
    _db = firestore.client()
    return _db
