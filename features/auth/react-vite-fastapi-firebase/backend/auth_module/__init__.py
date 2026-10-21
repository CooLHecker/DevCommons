"""Drop-in Firebase auth for FastAPI.

Usage:
    from auth_module import setup_auth, get_current_user, AuthUser

    setup_auth(app)                       # mounts /api/auth/me and /api/auth/register

    @app.get("/api/things")
    def things(user: AuthUser = Depends(get_current_user)):
        ...
"""

from .deps import AuthUser, get_current_user, get_optional_user, require_verified_email
from .firebase_client import init_firebase
from .hooks import configure
from .routes import router
from .setup import setup_auth

__all__ = [
    "AuthUser",
    "configure",
    "get_current_user",
    "get_optional_user",
    "init_firebase",
    "require_verified_email",
    "router",
    "setup_auth",
]
