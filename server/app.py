"""外部配套服务（雏形）：接收 DSH 进度同步插件 POST 的里程碑。

接口契约见 docs/progress-sync-design.md 第 4、5 节。
零额外依赖 —— 只用已安装的 Flask。

运行：
    cd server
    python app.py                     # 默认 127.0.0.1:8787

环境变量：
    DSH_PROGRESS_HOST      监听地址，默认 127.0.0.1
    DSH_PROGRESS_PORT      监听端口，默认 8787
    DSH_PROGRESS_SECRET    HMAC 密钥；留空则不校验签名（仅本地联调）
    DSH_PROGRESS_MAX_SKEW  时间戳容忍窗口（秒），默认 300
    DSH_PROGRESS_DATA      数据目录，默认 ./data
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import time
from pathlib import Path

from flask import Flask, jsonify, request

from store import MilestoneStore

SERVICE_NAME = "dsh-progress-service"
SERVICE_VERSION = "0.1.0"
SCHEMA_VERSION = 1

HOST = os.environ.get("DSH_PROGRESS_HOST", "127.0.0.1")
PORT = int(os.environ.get("DSH_PROGRESS_PORT", "8787"))
SECRET = os.environ.get("DSH_PROGRESS_SECRET", "")
MAX_SKEW_SEC = int(os.environ.get("DSH_PROGRESS_MAX_SKEW", "300"))
DATA_DIR = Path(os.environ.get("DSH_PROGRESS_DATA", Path(__file__).parent / "data"))

app = Flask(__name__)
store = MilestoneStore(DATA_DIR)
restored = store.load()

REQUIRED_FIELDS = ("deliveryId", "schemaVersion", "session", "milestone")


# --------------------------------------------------------------------- 工具函数


def _now_ms() -> int:
    return int(time.time() * 1000)


def _cors(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = (
        "Content-Type, X-DSH-Schema, X-DSH-Delivery, X-DSH-Timestamp, X-DSH-Signature, X-DSH-Session"
    )
    response.headers["Access-Control-Max-Age"] = "600"
    return response


def _verify_signature(raw: bytes) -> tuple[bool, str]:
    """校验 HMAC 签名。签名串为 ``<timestamp>.<rawBody>`` 的字节拼接。"""
    if not SECRET:
        return True, "verification-disabled"
    timestamp = request.headers.get("X-DSH-Timestamp")
    signature = request.headers.get("X-DSH-Signature", "")
    if not timestamp or not signature:
        return False, "缺少签名头"
    try:
        ts_ms = int(timestamp)
    except ValueError:
        return False, "时间戳格式错误"
    if abs(_now_ms() - ts_ms) > MAX_SKEW_SEC * 1000:
        return False, "时间戳超出容忍窗口（可能重放）"
    expected = hmac.new(
        SECRET.encode("utf-8"),
        timestamp.encode("utf-8") + b"." + raw,
        hashlib.sha256,
    ).hexdigest()
    provided = signature.split("=", 1)[1] if signature.startswith("sha256=") else signature
    if not hmac.compare_digest(expected, provided):
        return False, "签名不匹配"
    return True, "ok"


def _validate(envelope: dict) -> str | None:
    """返回错误说明；None 表示校验通过。"""
    for field in REQUIRED_FIELDS:
        if envelope.get(field) in (None, {}, ""):
            return f"缺少必填字段: {field}"
    session = envelope["session"]
    if not isinstance(session, dict) or not session.get("id"):
        return "session.id 缺失"
    milestone = envelope["milestone"]
    if not isinstance(milestone, dict) or not milestone.get("kind") or not milestone.get("status"):
        return "milestone.kind / milestone.status 缺失"
    return None


def _accept(envelope: dict, verify: str) -> tuple[dict, int]:
    """公共接收逻辑：校验 → 去重 → 落库。"""
    error = _validate(envelope)
    if error:
        return {"ok": False, "error": error}, 422

    delivery_id = envelope.get("deliveryId")
    if store.is_duplicate(delivery_id):
        # 设计约定：重复投递视同成功，返回 409 让插件出队
        return {"ok": True, "duplicate": True, "deliveryId": delivery_id}, 409

    record = store.append(
        envelope,
        meta={
            "signature": verify,
            "remote": request.remote_addr,
            "userAgent": request.headers.get("User-Agent"),
            "receivedAt": _now_ms(),
        },
    )
    return {
        "ok": True,
        "duplicate": False,
        "deliveryId": delivery_id,
        "receivedAt": record["receivedAt"],
        "kind": envelope["milestone"]["kind"],
        "status": envelope["milestone"]["status"],
    }, 202


# ----------------------------------------------------------------------- 路由


@app.after_request
def _after(response):
    return _cors(response)


@app.get("/")
def index():
    return jsonify(
        {
            "service": SERVICE_NAME,
            "version": SERVICE_VERSION,
            "schemaVersion": SCHEMA_VERSION,
            "signatureRequired": bool(SECRET),
            "endpoints": [
                "GET  /dsh/progress/v1/health",
                "POST /dsh/progress/v1/milestones",
                "POST /dsh/progress/v1/milestones:batch",
                "GET  /dsh/progress/v1/milestones?limit=50&sessionId=&kind=",
                "GET  /dsh/progress/v1/sessions",
                "GET  /dsh/progress/v1/state?sessionId=",
            ],
        }
    )


@app.get("/dsh/progress/v1/health")
def health():
    return jsonify(
        {
            "ok": True,
            "service": SERVICE_NAME,
            "version": SERVICE_VERSION,
            "schemaVersion": SCHEMA_VERSION,
            "signatureRequired": bool(SECRET),
            "time": _now_ms(),
            **store.stats(),
        }
    )


@app.post("/dsh/progress/v1/milestones")
def post_milestone():
    raw = request.get_data()
    ok, reason = _verify_signature(raw)
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


@app.post("/dsh/progress/v1/milestones:batch")
def post_milestone_batch():
    raw = request.get_data()
    ok, reason = _verify_signature(raw)
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
    accepted = sum(1 for r in results if r.get("ok") and not r.get("duplicate"))
    return jsonify({"ok": True, "accepted": accepted, "total": len(results), "results": results}), 202


@app.get("/dsh/progress/v1/milestones")
def list_milestones():
    limit = min(max(int(request.args.get("limit", 50)), 1), 500)
    return jsonify(
        {
            "ok": True,
            "items": store.milestones(
                limit=limit,
                session_id=request.args.get("sessionId"),
                kind=request.args.get("kind"),
            ),
        }
    )


@app.get("/dsh/progress/v1/sessions")
def list_sessions():
    return jsonify({"ok": True, "items": store.sessions()})


@app.get("/dsh/progress/v1/state")
def get_state():
    session_id = request.args.get("sessionId")
    if not session_id:
        # 未指定会话时返回全部会话状态，方便前端一次性拉取
        return jsonify({"ok": True, "items": store.sessions()})
    state = store.state(session_id)
    if state is None:
        return jsonify({"ok": False, "error": "未知会话"}), 404
    return jsonify({"ok": True, "item": state})


if __name__ == "__main__":
    print(f"[{SERVICE_NAME}] 数据文件: {store.stats()['jsonl']}")
    print(f"[{SERVICE_NAME}] 已恢复历史里程碑: {restored} 条")
    print(f"[{SERVICE_NAME}] 签名校验: {'开启' if SECRET else '关闭（本地联调模式）'}")
    print(f"[{SERVICE_NAME}] 监听 http://{HOST}:{PORT}")
    app.run(host=HOST, port=PORT, threaded=True, debug=False)
