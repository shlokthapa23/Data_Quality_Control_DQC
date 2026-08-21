from flask import Blueprint, jsonify, request

from auth import db as auth_db
from auth.security import create_access_token, hash_password, verify_password

auth_bp = Blueprint("auth", __name__, url_prefix="/api/auth")


def _user_public(user):
    return {
        "id": user["id"],
        "email": user["email"],
        "full_name": user["full_name"],
        "organization_id": user["organization_id"],
        "organization_name": user["organization_name"],
        "role": user["role"],
        "created_at": user["created_at"],
    }


@auth_bp.route("/register", methods=["POST"])
def register():
    body = request.get_json(silent=True) or {}
    email = (body.get("email") or "").strip().lower()
    password = body.get("password") or ""
    full_name = (body.get("full_name") or "").strip()
    organization_name = (body.get("organization_name") or "").strip()

    missing = [f for f, v in [
        ("email", email), ("password", password),
        ("full_name", full_name), ("organization_name", organization_name),
    ] if not v]
    if missing:
        return jsonify({"error": f"Missing fields: {', '.join(missing)}"}), 400
    if len(password) < 8:
        return jsonify({"error": "Password must be at least 8 characters"}), 400

    if auth_db.get_user_by_email(email):
        return jsonify({"error": "An account with that email already exists"}), 409

    # Each registration founds its own organization - there's no invite/join-
    # existing-org flow (not part of what was asked for), so this is the only
    # way an org comes into being.
    org_id = auth_db.create_organization(organization_name)
    auth_db.create_user(org_id, email, full_name, hash_password(password), role="owner")

    token = create_access_token({"sub": email})
    return jsonify({"access_token": token, "token_type": "bearer"}), 201


@auth_bp.route("/login", methods=["POST"])
def login():
    body = request.get_json(silent=True) or {}
    email = (body.get("email") or "").strip().lower()
    password = body.get("password") or ""

    user = auth_db.get_user_by_email(email)
    if not user or not verify_password(password, user["hashed_password"]):
        return jsonify({"error": "Incorrect email or password"}), 401

    token = create_access_token({"sub": user["email"]})
    return jsonify({"access_token": token, "token_type": "bearer"})


@auth_bp.route("/me", methods=["GET"])
def me():
    # request.current_user is set by app.py's before_request gate, which has
    # already rejected this request with 401 if the token was missing/invalid
    # - by the time a route body runs, it's always present.
    return jsonify(_user_public(request.current_user))
