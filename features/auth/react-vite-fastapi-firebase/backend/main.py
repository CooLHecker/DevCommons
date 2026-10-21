"""Demo app. In your own project you only need the lines marked  # <-- add."""

import os

from fastapi import Depends, FastAPI

from auth_module import AuthUser, get_current_user, setup_auth  # <-- add

app = FastAPI(title="devcommons auth demo")


# Optional: persist users in your own DB when they sign up.
async def on_register(user: AuthUser) -> None:
    print(f"New user registered: {user.uid} ({user.email})")


setup_auth(  # <-- add: loads credentials, enables CORS, mounts /api/auth/*
    app,
    cors_origins=os.getenv("ALLOWED_ORIGINS", "http://localhost:5173").split(","),
    on_register=on_register,
)


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.get("/api/secret")
def secret(user: AuthUser = Depends(get_current_user)):
    """Example of a protected route in your own code."""
    return {"message": f"Hello {user.name or user.email}, this is protected data."}
