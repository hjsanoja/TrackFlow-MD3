# Guarda el GitHub Personal Access Token en Firestore.
# Solo se ejecuta UNA vez (o cuando renueves el token).
#
# Uso:
#   GITHUB_TOKEN=ghp_xxx python scraper/save_github_token.py
#
# El token queda en Firestore en: secrets/github_dispatch
# Solo el admin puede leerlo (segun las reglas).

import os
import sys
from datetime import datetime, timezone

from firebase_client import get_db


def main():
    token = os.environ.get("GITHUB_TOKEN")
    if not token:
        print("ERROR: la variable de entorno GITHUB_TOKEN no esta definida.")
        print("Uso: GITHUB_TOKEN=ghp_xxx python scraper/save_github_token.py")
        sys.exit(1)

    if not token.startswith(("ghp_", "github_pat_")):
        print("ADVERTENCIA: el token no empieza con 'ghp_' ni 'github_pat_'.")
        print("Continuando de todos modos...")

    repo_owner = input("Tu usuario u organizacion de GitHub (ej. hjsanoja): ").strip()
    repo_name = input("Nombre del repo (ej. TrackFlow): ").strip()

    if not repo_owner or not repo_name:
        print("ERROR: usuario y repo son obligatorios")
        sys.exit(1)

    db = get_db()
    db.collection("secrets").document("github_dispatch").set({
        "token": token,
        "repo_owner": repo_owner,
        "repo_name": repo_name,
        "workflow_event_type": "run-scraper",
        "updated_at": datetime.now(timezone.utc),
    })

    print("")
    print("OK: token guardado en Firestore.")
    print("  Repo: " + repo_owner + "/" + repo_name)
    print("  Event type: run-scraper")


if __name__ == "__main__":
    main()
