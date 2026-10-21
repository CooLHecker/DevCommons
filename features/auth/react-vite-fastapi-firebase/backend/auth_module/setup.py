from typing import Iterable, Optional

from fastapi import FastAPI

from .firebase_client import init_firebase
from .hooks import Hook, configure
from .routes import router


def setup_auth(
    app: FastAPI,
    prefix: str = "/api",
    cors_origins: Optional[Iterable[str]] = None,
    on_register: Optional[Hook] = None,
) -> None:
    """One call to add auth to a FastAPI app.

        setup_auth(app)                                          # minimal
        setup_auth(app, cors_origins=["http://localhost:5173"])  # also enable CORS for your frontend

    - loads the Firebase credentials (fails fast with a clear message if they are missing)
    - mounts GET {prefix}/auth/me and POST {prefix}/auth/register
    - optionally adds CORS (skip cors_origins if your app already configures CORS)
    - optionally registers your on_register callback (sync or async) to save new users
    """
    init_firebase()

    if cors_origins:
        from fastapi.middleware.cors import CORSMiddleware

        app.add_middleware(
            CORSMiddleware,
            allow_origins=list(cors_origins),
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )

    if on_register is not None:
        configure(on_register=on_register)

    app.include_router(router, prefix=prefix)
