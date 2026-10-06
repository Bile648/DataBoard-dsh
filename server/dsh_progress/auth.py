"""账户、登录会话与摄入令牌。

设计取舍（按需求确认）：
- **关闭注册**：账号只能由管理员通过 CLI 创建。
- **共享看板**：登录只做门禁，不做数据隔离，所有登录用户看到同一份进度。
- **摄入鉴权**：插件用 Bearer 令牌；同时保留 HMAC 签名校验以兼容旧版插件。
"""

from __future__ import annotations

import functools
import hmac
import re
import sqlite3
from typing import Any, Callable

from flask import g, jsonify, request
from werkzeug.security import check_password_hash, generate_password_hash

from .config import Config, new_token
from .db import Database, now_ms

MIN_PASSWORD_LENGTH = 8
USERNAME_PATTERN = re.compile(r"^[A-Za-z0-9._-]{3,32}$")
SESSION_COOKIE = "dshp_session"
INGEST_TOKEN_META_KEY = "ingest_token"


class AuthError(Exception):
    """可直接反馈给调用方的认证/校验错误。"""


# --------------------------------------------------------------------- 密码


def hash_password(password: str) -> str:
    return generate_password_hash(password, method="scrypt")


def verify_password(password_hash: str, password: str) -> bool:
    try:
        return check_password_hash(password_hash, password)
    except (ValueError, TypeError):
        return False


def validate_credentials(username: str, password: str) -> None:
    if not USERNAME_PATTERN.match(username or ""):
        raise AuthError("用户名需为 3-32 位的字母、数字、点、下划线或连字符")
    if len(password or "") < MIN_PASSWORD_LENGTH:
        raise AuthError(f"密码至少 {MIN_PASSWORD_LENGTH} 位")


# --------------------------------------------------------------------- 用户


def create_user(
    db: Database,
    username: str,
    password: str,
    *,
    is_admin: bool = False,
    display_name: str | None = None,
) -> dict[str, Any]:
    validate_credentials(username, password)
    try:
        with db.conn:
            cursor = db.conn.execute(
                "INSERT INTO users(username, display_name, password_hash, is_admin, created_at)"
                " VALUES(?,?,?,?,?)",
                (username, display_name or username, hash_password(password), 1 if is_admin else 0, now_ms()),
            )
    except sqlite3.IntegrityError as exc:
        raise AuthError(f"用户名已存在：{username}") from exc
    return get_user(db, cursor.lastrowid)


def get_user(db: Database, user_id: int) -> dict[str, Any]:
    row = db.conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    return _public_user(row) if row else {}


def find_user(db: Database, username: str) -> sqlite3.Row | None:
    return db.conn.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()


def list_users(db: Database) -> list[dict[str, Any]]:
    rows = db.conn.execute("SELECT * FROM users ORDER BY id ASC").fetchall()
    return [_public_user(row) for row in rows]


def count_admins(db: Database) -> int:
    return db.conn.execute("SELECT COUNT(*) AS n FROM users WHERE is_admin = 1").fetchone()["n"]


def set_password(db: Database, username: str, password: str) -> bool:
    if len(password or "") < MIN_PASSWORD_LENGTH:
        raise AuthError(f"密码至少 {MIN_PASSWORD_LENGTH} 位")
    with db.conn:
        cursor = db.conn.execute(
            "UPDATE users SET password_hash = ? WHERE username = ?",
            (hash_password(password), username),
        )
        # 改密后吊销该用户所有登录会话
        db.conn.execute(
            "DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE username = ?)",
            (username,),
        )
    return bool(cursor.rowcount)


def delete_user(db: Database, username: str) -> bool:
    with db.conn:
        cursor = db.conn.execute("DELETE FROM users WHERE username = ?", (username,))
    return bool(cursor.rowcount)


def _public_user(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "username": row["username"],
        "displayName": row["display_name"],
        "isAdmin": bool(row["is_admin"]),
        "createdAt": row["created_at"],
        "lastLoginAt": row["last_login_at"],
    }


# ------------------------------------------------------------------- 登录会话


def authenticate(db: Database, username: str, password: str) -> dict[str, Any] | None:
    row = find_user(db, username)
    if not row or not verify_password(row["password_hash"], password):
        return None
    with db.conn:
        db.conn.execute("UPDATE users SET last_login_at = ? WHERE id = ?", (now_ms(), row["id"]))
    return _public_user(row)


def create_session(db: Database, user_id: int, ttl_seconds: int) -> tuple[str, int]:
    token = new_token("dshs")
    expires_at = now_ms() + ttl_seconds * 1000
    with db.conn:
        db.conn.execute(
            "INSERT INTO sessions(token, user_id, created_at, expires_at) VALUES(?,?,?,?)",
            (token, user_id, now_ms(), expires_at),
        )
    return token, expires_at


def resolve_session(db: Database, token: str | None) -> dict[str, Any] | None:
    if not token:
        return None
    row = db.conn.execute(
        "SELECT u.*, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?",
        (token,),
    ).fetchone()
    if not row:
        return None
    if int(row["expires_at"]) < now_ms():
        destroy_session(db, token)
        return None
    return _public_user(row)


def destroy_session(db: Database, token: str | None) -> None:
    if not token:
        return
    with db.conn:
        db.conn.execute("DELETE FROM sessions WHERE token = ?", (token,))


def destroy_user_sessions(db: Database, user_id: int) -> int:
    with db.conn:
        cursor = db.conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
    return cursor.rowcount or 0


# ------------------------------------------------------------------- 摄入令牌


def current_ingest_token(db: Database, config: Config) -> str:
    """环境变量优先；否则用数据库里持久化的令牌；都没有则生成一个并保存。"""
    if config.ingest_token:
        return config.ingest_token
    stored = db.get_meta(INGEST_TOKEN_META_KEY)
    if stored:
        return stored
    token = new_token("dshi")
    db.set_meta(INGEST_TOKEN_META_KEY, token)
    return token


def rotate_ingest_token(db: Database, config: Config) -> str:
    if config.ingest_token:
        raise AuthError("摄入令牌由环境变量 DSH_PROGRESS_INGEST_TOKEN 固定，无法在运行时轮换")
    token = new_token("dshi")
    db.set_meta(INGEST_TOKEN_META_KEY, token)
    return token


def verify_ingest_token(db: Database, config: Config, presented: str | None) -> bool:
    if not presented:
        return False
    expected = current_ingest_token(db, config)
    return hmac.compare_digest(presented, expected)


# ------------------------------------------------------------------ 请求上下文


def load_current_user(db: Database) -> dict[str, Any] | None:
    """每个请求解析一次当前用户，缓存在 flask.g。"""
    if "current_user" not in g:
        g.current_user = resolve_session(db, request.cookies.get(SESSION_COOKIE))
    return g.current_user


def login_required(view: Callable) -> Callable:
    @functools.wraps(view)
    def wrapper(*args, **kwargs):
        user = load_current_user(g.db)
        if not user:
            return jsonify({"ok": False, "error": "未登录或会话已过期"}), 401
        return view(*args, **kwargs)

    return wrapper


def admin_required(view: Callable) -> Callable:
    @functools.wraps(view)
    def wrapper(*args, **kwargs):
        user = load_current_user(g.db)
        if not user:
            return jsonify({"ok": False, "error": "未登录或会话已过期"}), 401
        if not user["isAdmin"]:
            return jsonify({"ok": False, "error": "需要管理员权限"}), 403
        return view(*args, **kwargs)

    return wrapper
