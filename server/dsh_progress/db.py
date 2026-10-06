"""SQLite 存储层：建表、迁移、连接管理。

为什么从 JSONL 换成 SQLite：真服务器部署需要并发写、按时间/会话建索引查询、
以及不把全部历史读进内存。JSONL 版本会在启动时把全量数据加载到内存并截断到 2000 条，
不适合长期运行。
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Iterable

SCHEMA_VERSION = 1

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    NOT NULL UNIQUE,
    display_name  TEXT,
    password_hash TEXT    NOT NULL,
    is_admin      INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL,
    last_login_at INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT    PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS milestones (
    delivery_id TEXT    PRIMARY KEY,
    received_at INTEGER NOT NULL,
    event_at    INTEGER NOT NULL,
    session_id  TEXT,
    kind        TEXT,
    status      TEXT,
    priority    TEXT,
    title       TEXT,
    envelope    TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_milestones_event   ON milestones(event_at DESC);
CREATE INDEX IF NOT EXISTS idx_milestones_session ON milestones(session_id, event_at DESC);

CREATE TABLE IF NOT EXISTS session_state (
    session_id TEXT    PRIMARY KEY,
    state      TEXT    NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


def now_ms() -> int:
    return int(time.time() * 1000)


class Database:
    """线程内共享连接的轻量封装（Flask 开发服务器与 gunicorn 线程模型都适用）。"""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self._local = threading.local()

    # ------------------------------------------------------------------ 连接

    @property
    def conn(self) -> sqlite3.Connection:
        conn = getattr(self._local, "conn", None)
        if conn is None:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            conn = sqlite3.connect(self.path, timeout=15)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA foreign_keys=ON")
            conn.execute("PRAGMA busy_timeout=15000")
            self._local.conn = conn
        return conn

    def close(self) -> None:
        conn = getattr(self._local, "conn", None)
        if conn is not None:
            conn.close()
            self._local.conn = None

    # ------------------------------------------------------------------ 初始化

    def initialize(self, legacy_jsonl: Path | None = None) -> dict[str, Any]:
        self.conn.executescript(SCHEMA)
        self.conn.commit()
        self.set_meta("schema_version", str(SCHEMA_VERSION))
        imported = 0
        if legacy_jsonl is not None and legacy_jsonl.exists():
            imported = self.import_legacy_jsonl(legacy_jsonl)
        return {"imported": imported, "schemaVersion": SCHEMA_VERSION}

    # -------------------------------------------------------------------- meta

    def get_meta(self, key: str) -> str | None:
        row = self.conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else None

    def set_meta(self, key: str, value: str) -> None:
        self.conn.execute(
            "INSERT INTO meta(key, value) VALUES(?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )
        self.conn.commit()

    # ------------------------------------------------------- 旧 JSONL 数据迁移

    def import_legacy_jsonl(self, jsonl: Path) -> int:
        """把旧版 JSONL 里的里程碑导入 SQLite（仅在库为空时执行，幂等）。"""
        existing = self.conn.execute("SELECT COUNT(*) AS n FROM milestones").fetchone()["n"]
        if existing:
            return 0
        imported = 0
        for line in jsonl.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            envelope = record.get("envelope") or {}
            delivery_id = envelope.get("deliveryId")
            if not isinstance(delivery_id, str):
                continue
            milestone = envelope.get("milestone") or {}
            session = envelope.get("session") or {}
            try:
                self.conn.execute(
                    "INSERT OR IGNORE INTO milestones"
                    "(delivery_id, received_at, event_at, session_id, kind, status, priority, title, envelope)"
                    " VALUES(?,?,?,?,?,?,?,?,?)",
                    (
                        delivery_id,
                        int(record.get("receivedAt") or now_ms()),
                        int(milestone.get("at") or envelope.get("emittedAt") or 0),
                        session.get("id"),
                        milestone.get("kind"),
                        milestone.get("status"),
                        milestone.get("priority"),
                        milestone.get("title"),
                        json.dumps(envelope, ensure_ascii=False),
                    ),
                )
                imported += 1
            except sqlite3.Error:
                continue
        self.conn.commit()
        if imported:
            self.rebuild_state()
        return imported

    def rebuild_state(self) -> int:
        """按事件时间重放全部里程碑，重建会话状态快照。"""
        from .store import fold_envelope  # 局部导入避免循环依赖

        self.conn.execute("DELETE FROM session_state")
        rows = self.conn.execute("SELECT envelope FROM milestones ORDER BY event_at ASC, received_at ASC")
        states: dict[str, dict[str, Any]] = {}
        for row in rows:
            envelope = json.loads(row["envelope"])
            session_id = fold_envelope(states, envelope)
            if session_id:
                states.setdefault(session_id, {})["sessionId"] = session_id
        for session_id, state in states.items():
            self.conn.execute(
                "INSERT OR REPLACE INTO session_state(session_id, state, updated_at) VALUES(?,?,?)",
                (session_id, json.dumps(state, ensure_ascii=False), now_ms()),
            )
        self.conn.commit()
        return len(states)

    # ------------------------------------------------------------------ 维护

    def vacuum(self) -> None:
        self.conn.execute("VACUUM")
        self.conn.commit()

    def purge_sessions(self) -> int:
        cursor = self.conn.execute("DELETE FROM sessions WHERE expires_at < ?", (now_ms(),))
        self.conn.commit()
        return cursor.rowcount or 0
