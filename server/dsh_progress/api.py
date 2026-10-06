"""HTTP 接口层。

三组接口分开鉴权：
- ``/api/auth/*``        登录会话（Cookie）
- ``/api/*``             看板读取与管理（登录后可用；管理操作需管理员）
- ``/dsh/progress/v1/*`` 插件摄入（Bearer 摄入令牌，或旧版 HMAC 签名）
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import time
from typing import Any

from flask import Blueprint, Response, g, jsonify, request

from . import auth
from .config import Config
from .db import Database
from .store import MilestoneStore

log = logging.getLogger("dsh_progress.ingest")

SERVICE_NAME = "dsh-progress-service"
SERVICE_VERSION = "1.0.0"
SCHEMA_VERSION = 1

# 登录失败节流（进程内；单实例部署足够）
LOGIN_WINDOW_SECONDS = 900
LOGIN_MAX_FAILURES = 5
_login_failures: dict[str, list[float]] = {}

ingest = Blueprint("ingest", __name__, url_prefix="/dsh/progress/v1")
web = Blueprint("web", __name__, url_prefix="/api")
admin = Blueprint("admin", __name__, url_prefix="/api/admin")


# --------------------------------------------------------------------- 工具


def _store() -> MilestoneStore:
    return MilestoneStore(g.db)


def _json_body() -> dict[str, Any]:
    data = request.get_json(silent=True)
    return data if isinstance(data, dict) else {}


def _verify_signature(raw: bytes) -> tuple[bool, str]:
    """旧版插件的 HMAC 校验：签名串为 ``<timestamp>.<rawBody>``。"""
    config: Config = g.config
    if not config.hmac_secret:
        return False, "服务端未配置 HMAC 密钥"
    timestamp = request.headers.get("X-DSH-Timestamp")
    signature = request.headers.get("X-DSH-Signature", "")
    if not timestamp or not signature:
        return False, "缺少签名头"
    try:
        ts_ms = int(timestamp)
    except ValueError:
        return False, "时间戳格式错误"
    if abs(int(time.time() * 1000) - ts_ms) > config.max_skew_seconds * 1000:
        return False, "时间戳超出容忍窗口（可能重放）"
    expected = hmac.new(
        config.hmac_secret.encode("utf-8"),
        timestamp.encode("utf-8") + b"." + raw,
        hashlib.sha256,
    ).hexdigest()
    presented = signature.split("=", 1)[1] if signature.startswith("sha256=") else signature
    if not hmac.compare_digest(expected, presented):
        return False, "签名不匹配"
    return True, "hmac"


def _authorize_ingest(raw: bytes) -> tuple[bool, str]:
    config: Config = g.config
    header = request.headers.get("Authorization", "")
    if header.startswith("Bearer "):
        if auth.verify_ingest_token(g.db, config, header[7:].strip()):
            return True, "token"
        return False, "摄入令牌无效"
    if config.hmac_secret:
        ok, reason = _verify_signature(raw)
        if ok:
            return True, reason
        # 同时开了 HMAC 时，把两条可用路径都告诉调用方，避免误导
        return False, f"{reason}（也可改用 Authorization: Bearer <摄入令牌>）"
    return False, "缺少凭据：请在插件里配置摄入令牌（Authorization: Bearer …）"


def _validate(envelope: dict[str, Any]) -> str | None:
    if not isinstance(envelope.get("deliveryId"), str) or not envelope["deliveryId"]:
        return "缺少必填字段: deliveryId"
    session = envelope.get("session")
    if not isinstance(session, dict) or not session.get("id"):
        return "session.id 缺失"
    milestone = envelope.get("milestone")
    if not isinstance(milestone, dict) or not milestone.get("kind") or not milestone.get("status"):
        return "milestone.kind / milestone.status 缺失"
    return None


def _accept(envelope: dict[str, Any], mode: str) -> tuple[dict[str, Any], int]:
    error = _validate(envelope)
    if error:
        return {"ok": False, "error": error}, 422

    delivery_id = envelope["deliveryId"]
    if _store().is_duplicate(delivery_id):
        # 设计约定：重复投递视同成功，返回 409 让插件出队
        return {"ok": True, "duplicate": True, "deliveryId": delivery_id}, 409

    record = _store().append(
        envelope,
        meta={"auth": mode, "remote": request.remote_addr, "userAgent": request.headers.get("User-Agent")},
    )
    if record is None:
        return {"ok": True, "duplicate": True, "deliveryId": delivery_id}, 409
    log.info(
        "摄入 %s  %s/%s  auth=%s  session=%s",
        delivery_id[:8],
        record["kind"],
        record["status"],
        mode,
        (envelope.get("session") or {}).get("id"),
    )
    return {
        "ok": True,
        "duplicate": False,
        "deliveryId": delivery_id,
        "receivedAt": record["receivedAt"],
        "kind": record["kind"],
        "status": record["status"],
    }, 202


# ------------------------------------------------------------------- 摄入接口


@ingest.get("/health")
def ingest_health():
    """无需鉴权：插件配置页用它做「测试连接」。"""
    return jsonify(
        {
            "ok": True,
            "service": SERVICE_NAME,
            "version": SERVICE_VERSION,
            "schemaVersion": SCHEMA_VERSION,
            "requiresToken": not g.config.hmac_secret,
            "time": int(time.time() * 1000),
        }
    )


@ingest.post("/milestones")
def post_milestone():
    raw = request.get_data()
    ok, reason = _authorize_ingest(raw)
    if not ok:
        return jsonify({"ok": False, "error": reason}), 401
    try:
        envelope = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        return jsonify({"ok": False, "error": f"JSON 解析失败: {exc}"}), 400
    if not isinstance(envelope, dict):
        return jsonify({"ok": False, "error": "载荷必须是 JSON 对象"}), 400
    body, status = _accept(envelope, reason)
    return jsonify(body), status


@ingest.post("/milestones:batch")
def post_milestone_batch():
    raw = request.get_data()
    ok, reason = _authorize_ingest(raw)
    if not ok:
        return jsonify({"ok": False, "error": reason}), 401
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        return jsonify({"ok": False, "error": f"JSON 解析失败: {exc}"}), 400
    items = payload.get("items") if isinstance(payload, dict) else payload
    if not isinstance(items, list):
        return jsonify({"ok": False, "error": "batch 载荷需为数组或 {items: []}"}), 400

    results = []
    for envelope in items:
        if not isinstance(envelope, dict):
            results.append({"ok": False, "error": "条目不是对象"})
            continue
        body, status = _accept(envelope, reason)
        body["status"] = status
        results.append(body)
    accepted = sum(1 for item in results if item.get("ok") and not item.get("duplicate"))
    return jsonify({"ok": True, "accepted": accepted, "total": len(results), "results": results}), 202


# --------------------------------------------------------------------- 认证


@web.post("/auth/login")
def login():
    body = _json_body()
    username = str(body.get("username") or "").strip()
    password = str(body.get("password") or "")

    key = f"{request.remote_addr}|{username}"
    now = time.time()
    attempts = [t for t in _login_failures.get(key, []) if now - t < LOGIN_WINDOW_SECONDS]
    if len(attempts) >= LOGIN_MAX_FAILURES:
        retry_after = int(LOGIN_WINDOW_SECONDS - (now - attempts[0]))
        return (
            jsonify({"ok": False, "error": f"登录失败次数过多，请 {max(1, retry_after // 60)} 分钟后再试"}),
            429,
        )

    user = auth.authenticate(g.db, username, password)
    if not user:
        attempts.append(now)
        _login_failures[key] = attempts
        return jsonify({"ok": False, "error": "用户名或密码错误"}), 401

    _login_failures.pop(key, None)
    token, expires_at = auth.create_session(g.db, user["id"], g.config.session_ttl_seconds)
    response = jsonify({"ok": True, "user": user, "expiresAt": expires_at})
    response.set_cookie(
        auth.SESSION_COOKIE,
        token,
        max_age=g.config.session_ttl_seconds,
        httponly=True,
        samesite="Lax",
        secure=g.config.secure_cookie,
        path="/",
    )
    return response


@web.post("/auth/logout")
def logout():
    auth.destroy_session(g.db, request.cookies.get(auth.SESSION_COOKIE))
    response = jsonify({"ok": True})
    response.delete_cookie(auth.SESSION_COOKIE, path="/")
    return response


@web.get("/auth/me")
def me():
    user = auth.load_current_user(g.db)
    if not user:
        return jsonify({"ok": False, "error": "未登录"}), 401
    return jsonify({"ok": True, "user": user})


@web.post("/auth/password")
@auth.login_required
def change_own_password():
    body = _json_body()
    user = auth.load_current_user(g.db)
    row = auth.find_user(g.db, user["username"])
    if not row or not auth.verify_password(row["password_hash"], str(body.get("currentPassword") or "")):
        return jsonify({"ok": False, "error": "当前密码不正确"}), 400
    try:
        auth.set_password(g.db, user["username"], str(body.get("newPassword") or ""))
    except auth.AuthError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400
    return jsonify({"ok": True})


# --------------------------------------------------------------- 看板数据接口


@web.get("/health")
@auth.login_required
def health():
    return jsonify({"ok": True, **{k: v for k, v in _store().stats().items()}, "authRequired": True})


@web.get("/milestones")
@auth.login_required
def list_milestones():
    limit = min(max(int(request.args.get("limit", 50)), 1), 500)
    return jsonify(
        {
            "ok": True,
            "items": _store().milestones(
                limit=limit,
                session_id=request.args.get("sessionId"),
                kind=request.args.get("kind"),
            ),
        }
    )


@web.get("/sessions")
@auth.login_required
def list_sessions():
    return jsonify({"ok": True, "items": _store().sessions()})


@web.get("/state")
@auth.login_required
def get_state():
    session_id = request.args.get("sessionId")
    if not session_id:
        return jsonify({"ok": True, "items": _store().sessions()})
    state = _store().state(session_id)
    if state is None:
        return jsonify({"ok": False, "error": "未知会话"}), 404
    return jsonify({"ok": True, "item": state})


# ------------------------------------------------------------------- 管理接口


def _plugin_snippet(token: str) -> str:
    """生成可直接粘贴进 DSH profile 的配置片段。"""
    base = request.host_url.rstrip("/")
    return (
        "# 追加到 $DSH_HOME/profiles/<profile>/cordis.patch.yml\n"
        "- insert:\n"
        "    - id: progress-sync\n"
        '      name: "/absolute/path/to/plugin/src/index.js"\n'
        "      config:\n"
        f"        endpoint: {base}\n"
        f"        token: {token}\n"
    )


@admin.get("/users")
@auth.admin_required
def admin_list_users():
    return jsonify({"ok": True, "items": auth.list_users(g.db)})


@admin.post("/users")
@auth.admin_required
def admin_create_user():
    body = _json_body()
    try:
        user = auth.create_user(
            g.db,
            str(body.get("username") or "").strip(),
            str(body.get("password") or ""),
            is_admin=bool(body.get("isAdmin")),
            display_name=(str(body["displayName"]).strip() if body.get("displayName") else None),
        )
    except auth.AuthError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400
    return jsonify({"ok": True, "user": user}), 201


@admin.delete("/users/<username>")
@auth.admin_required
def admin_delete_user(username: str):
    me_user = auth.load_current_user(g.db)
    if username == me_user["username"]:
        return jsonify({"ok": False, "error": "不能删除当前登录的账号"}), 400
    row = auth.find_user(g.db, username)
    if not row:
        return jsonify({"ok": False, "error": "用户不存在"}), 404
    if row["is_admin"] and auth.count_admins(g.db) <= 1:
        return jsonify({"ok": False, "error": "不能删除最后一个管理员"}), 400
    auth.delete_user(g.db, username)
    return jsonify({"ok": True})


@admin.post("/users/<username>/password")
@auth.admin_required
def admin_set_password(username: str):
    try:
        changed = auth.set_password(g.db, username, str(_json_body().get("password") or ""))
    except auth.AuthError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400
    if not changed:
        return jsonify({"ok": False, "error": "用户不存在"}), 404
    return jsonify({"ok": True})


@admin.get("/ingest-token")
@auth.admin_required
def admin_get_ingest_token():
    token = auth.current_ingest_token(g.db, g.config)
    return jsonify(
        {
            "ok": True,
            "token": token,
            "managedByEnv": bool(g.config.ingest_token),
            "snippet": _plugin_snippet(token),
        }
    )


@admin.post("/ingest-token/rotate")
@auth.admin_required
def admin_rotate_ingest_token():
    try:
        token = auth.rotate_ingest_token(g.db, g.config)
    except auth.AuthError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400
    return jsonify({"ok": True, "token": token, "snippet": _plugin_snippet(token)})


@admin.post("/milestones/clear")
@auth.admin_required
def admin_clear_milestones():
    removed = _store().clear_milestones()
    return jsonify({"ok": True, "removed": removed})


@admin.get("/sessions")
@auth.admin_required
def admin_list_sessions():
    """当前有效的登录会话（仅本进程可见的粗略视图）。"""
    rows = g.db.conn.execute(
        "SELECT s.token, s.created_at, s.expires_at, u.username FROM sessions s"
        " JOIN users u ON u.id = s.user_id ORDER BY s.created_at DESC"
    ).fetchall()
    return jsonify(
        {
            "ok": True,
            "items": [
                {
                    "id": row["token"][:12],
                    "username": row["username"],
                    "createdAt": row["created_at"],
                    "expiresAt": row["expires_at"],
                }
                for row in rows
            ],
        }
    )


def register(app) -> None:
    app.register_blueprint(ingest)
    app.register_blueprint(web)
    app.register_blueprint(admin)


__all__ = ["register", "ingest", "web", "admin", "Response", "Database"]
