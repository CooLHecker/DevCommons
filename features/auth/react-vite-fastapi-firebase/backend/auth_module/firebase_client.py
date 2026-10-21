"""Firebase Admin initialisation.

Credentials are resolved in this order:
1. FIREBASE_CREDENTIALS_JSON       - the service-account JSON as a string (good for hosting platforms)
2. GOOGLE_APPLICATION_CREDENTIALS  - path to the service-account JSON file
3. Application Default Credentials - only when FIREBASE_PROJECT_ID is also set (Cloud Run etc.)

A .env file next to (or above) this package, or in the folder you start uvicorn from,
is loaded automatically. Real environment variables win over the file.
"""

import json
import logging
import os

import firebase_admin
from firebase_admin import auth, credentials

try:
    from dotenv import find_dotenv, load_dotenv

    load_dotenv(find_dotenv(usecwd=True))  # folder uvicorn was started from
    load_dotenv(find_dotenv())  # .env beside / above this package
except ImportError:  # python-dotenv is optional; plain environment variables still work
    pass

logger = logging.getLogger("auth_module")


def init_firebase() -> firebase_admin.App:
    """Initialise Firebase Admin once. Raises RuntimeError with a clear message if misconfigured.

    Call it at startup (see main.py) so a bad setup fails immediately instead of on the first request.
    """
    try:
        return firebase_admin.get_app()
    except ValueError:
        pass

    raw_json = os.getenv("FIREBASE_CREDENTIALS_JSON")
    key_path = os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
    project_id = os.getenv("FIREBASE_PROJECT_ID") or os.getenv("GOOGLE_CLOUD_PROJECT")
    options = None

    if raw_json:
        cred = credentials.Certificate(json.loads(raw_json))
    elif key_path:
        if not os.path.isfile(key_path):
            raise RuntimeError(
                f"GOOGLE_APPLICATION_CREDENTIALS points to '{key_path}', but no such file exists "
                f"(current folder: {os.getcwd()}). Use an absolute path, or start the server from the "
                "folder that contains the key."
            )
        cred = credentials.Certificate(key_path)
    elif project_id:
        cred = credentials.ApplicationDefault()
        options = {"projectId": project_id}
    else:
        raise RuntimeError(
            "No Firebase credentials found. Put GOOGLE_APPLICATION_CREDENTIALS=<path to service "
            "account JSON> (or FIREBASE_CREDENTIALS_JSON) in backend/.env. Download the key from "
            "Firebase console -> Project settings -> Service accounts -> Generate new private key."
        )

    app = firebase_admin.initialize_app(cred, options)
    if not app.project_id:
        raise RuntimeError(
            "Firebase initialised without a project ID. Use a service-account key, or set FIREBASE_PROJECT_ID."
        )

    # Must equal VITE_FIREBASE_PROJECT_ID in the frontend, or every token is rejected.
    print(f"[auth_module] Firebase Admin initialised for project: {app.project_id}")
    return app


def verify_id_token(token: str) -> dict:
    """Verify a Firebase ID token and return its decoded claims.

    Raises the firebase_admin.auth exceptions on failure; deps.py maps them to HTTP 401.
    """
    init_firebase()
    check_revoked = os.getenv("AUTH_CHECK_REVOKED", "false").lower() == "true"
    # A few seconds of tolerance avoids "Token used too early" when the machine's
    # clock is slightly behind Google's (very common on dev laptops). Max is 60.
    skew = min(int(os.getenv("AUTH_CLOCK_SKEW_SECONDS", "10")), 60)
    return auth.verify_id_token(token, check_revoked=check_revoked, clock_skew_seconds=skew)
