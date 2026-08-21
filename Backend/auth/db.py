import uuid
from datetime import datetime, timezone

from catalog.db import get_conn  # reuse the same catalog.db connection helper


def init_auth_tables():
    """
    Additive-only, same as every other init_*_tables() in this codebase - plain
    CREATE TABLE IF NOT EXISTS, no destructive migration. These are brand new
    tables so there's nothing to backfill.
    """
    with get_conn() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS organizations (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                organization_id TEXT NOT NULL,
                email TEXT NOT NULL UNIQUE,
                full_name TEXT NOT NULL,
                hashed_password TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'owner',
                created_at TEXT NOT NULL
            )
        """)


def create_organization(name):
    org_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO organizations (id, name, created_at) VALUES (?, ?, ?)",
            (org_id, name, now),
        )
    return org_id


def create_user(organization_id, email, full_name, hashed_password, role="owner"):
    user_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO users (id, organization_id, email, full_name, hashed_password, role, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (user_id, organization_id, email, full_name, hashed_password, role, now),
        )
    return user_id


def get_user_by_email(email):
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
        return dict(row) if row else None


def get_user_with_org_by_email(email):
    with get_conn() as conn:
        row = conn.execute(
            "SELECT u.*, o.name AS organization_name FROM users u "
            "JOIN organizations o ON o.id = u.organization_id WHERE u.email = ?",
            (email,),
        ).fetchone()
        return dict(row) if row else None


def get_user_with_org_by_id(user_id):
    with get_conn() as conn:
        row = conn.execute(
            "SELECT u.*, o.name AS organization_name FROM users u "
            "JOIN organizations o ON o.id = u.organization_id WHERE u.id = ?",
            (user_id,),
        ).fetchone()
        return dict(row) if row else None
