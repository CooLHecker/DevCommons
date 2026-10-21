"""Dev helper: print a password-reset link that opens your app's reset-password screen.

    python dev_reset_link.py user@example.com

It uses the Admin SDK, so no email is sent and no mail scanner can use the link up first.
It also works without changing the "action URL" in the Firebase console.

Never turn this into an HTTP endpoint: anyone who could call it could take over any account.
"""

import os
import sys
from urllib.parse import parse_qs, urlparse

from firebase_admin import auth

from auth_module.firebase_client import init_firebase


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit("Usage: python dev_reset_link.py user@example.com")
    email = sys.argv[1].strip()

    init_firebase()
    try:
        firebase_link = auth.generate_password_reset_link(email)
    except auth.UserNotFoundError:
        sys.exit(f"No Firebase user with the email {email}")
    except Exception as exc:  # noqa: BLE001 - show whatever Firebase said
        sys.exit(f"Could not create a reset link: {exc}")

    code = parse_qs(urlparse(firebase_link).query).get("oobCode", [None])[0]
    if not code:
        sys.exit(f"Firebase returned a link without an oobCode: {firebase_link}")

    base = os.getenv("FRONTEND_URL", "http://localhost:5173").rstrip("/")
    print("\nOpen this in your browser (valid for 1 hour, single use):\n")
    # <AuthGate> reads ?mode=resetPassword&oobCode=... on whatever page it is mounted on.
    print(f"{base}/?mode=resetPassword&oobCode={code}\n")


if __name__ == "__main__":
    main()
