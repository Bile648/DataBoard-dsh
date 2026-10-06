"""里程碑存储：SQLite 落盘 + 会话状态折叠。

状态折叠把每条里程碑累积成「会话当前状态快照」，供看板直接渲染。
"""

from __future__ import annotations

import json
import sqlite3
from typing import Any

from .db import Database, now_ms


def blank_state(session_id: str) -> dict[str, Any]:
    return {
        "sessionId": session_id,
        "session": {},
        "goal": None,
        "todos": [],
        "counts": {},
        "completionRatio": None,
        "lastStatus": None,
        "lastKind": None,
        "lastMilestoneAt": None,
        "milestoneCount": 0,
        "latestReport": None,
        "artifacts": [],
        "lastSeq": None,
    }


def fold_envelope(states: dict[str, dict[str, Any]], envelope: dict[str, Any]) -> str | None:
    """把一个信封折叠进 ``states``，返回受影响的 sessionId（无会话则为 None）。"""
    session = envelope.get("session") or {}
    session_id = session.get("id")
    if not session_id:
        return None

    milestone = envelope.get("milestone") or {}
    task = envelope.get("task") or {}
    current = states.setdefault(session_id, blank_state(session_id))
    current["sessionId"] = session_id

    current["session"] = {**current.get("session", {}), **session}
    current["milestoneCount"] = int(current.get("milestoneCount") or 0) + 1
    current["lastKind"] = milestone.get("kind")
    current["lastStatus"] = milestone.get("status")
    current["lastMilestoneAt"] = milestone.get("at") or envelope.get("emittedAt")
    current["lastSeq"] = session.get("seq")

    if task.get("goal") is not None:
        current["goal"] = task["goal"]
    if task.get("todos"):
        current["todos"] = task["todos"]
    if task.get("counts"):
        current["counts"] = task["counts"]
    if task.get("completionRatio") is not None:
        current["completionRatio"] = task["completionRatio"]
    if envelope.get("artifacts"):
        current["artifacts"] = envelope["artifacts"]

    report = envelope.get("report")
    if report:
        current["latestReport"] = {
            "title": report.get("title"),
            "body": report.get("body"),
            "bytes": report.get("bytes"),
            "truncated": report.get("truncated", False),
            "source": report.get("source"),
            "sha256": report.get("sha256"),
            "at": milestone.get("at") or envelope.get("emittedAt"),
        }
    return session_id


class MilestoneStore:
    """基于 SQLite 的里程碑仓库。"""

    def __init__(self, db: Database) -> None:
        self.db = db

    # ------------------------------------------------------------------- 写入

    def is_duplicate(self, delivery_id: str | None) -> bool:
        if not delivery_id:
            return False
        row = self.db.conn.execute(
            "SELECT 1 FROM milestones WHERE delivery_id = ?", (delivery_id,)
        ).fetchone()
        return row is not None

    def append(self, envelope: dict[str, Any], meta: dict[str, Any] | None = None) -> dict[str, Any] | None:
        """写入一条里程碑；``deliveryId`` 已存在时返回 None（幂等）。"""
        delivery_id = envelope.get("deliveryId")
        if not isinstance(delivery_id, str) or not delivery_id:
            raise ValueError("deliveryId 缺失")

        milestone = envelope.get("milestone") or {}
        session = envelope.get("session") or {}
        session_id = session.get("id")
        received_at = now_ms()
        event_at = int(milestone.get("at") or envelope.get("emittedAt") or received_at)

        conn = self.db.conn
        try:
            with conn:
                conn.execute(
                    "INSERT INTO milestones"
                    "(delivery_id, received_at, event_at, session_id, kind, status, priority, title, envelope)"
                    " VALUES(?,?,?,?,?,?,?,?,?)",
                    (
                        delivery_id,
                        received_at,
                        event_at,
                        session_id,
                        milestone.get("kind"),
                        milestone.get("status"),
                        milestone.get("priority"),
                        milestone.get("title"),
                        json.dumps(envelope, ensure_ascii=False),
                    ),
                )
                if session_id:
                    row = conn.execute(
                        "SELECT state FROM session_state WHERE session_id = ?", (session_id,)
                    ).fetchone()
                    state = json.loads(row["state"]) if row else blank_state(session_id)
                    fold_envelope({session_id: state}, envelope)
                    conn.execute(
                        "INSERT INTO session_state(session_id, state, updated_at) VALUES(?,?,?) "
                        "ON CONFLICT(session_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at",
                        (session_id, json.dumps(state, ensure_ascii=False), received_at),
                    )
        except sqlite3.IntegrityError:
            # 并发下的重复投递：按幂等处理
            return None

        return {
            "receivedAt": received_at,
            "deliveryId": delivery_id,
            "kind": milestone.get("kind"),
            "status": milestone.get("status"),
            "meta": meta or {},
        }

    # ------------------------------------------------------------------- 读取

    def milestones(
        self,
        limit: int = 50,
        session_id: str | None = None,
        kind: str | None = None,
    ) -> list[dict[str, Any]]:
        """按**事件时间**倒序返回，还原真实发生顺序（合并窗口会让到达顺序乱掉）。"""
        sql = "SELECT delivery_id, received_at, envelope FROM milestones"
        clauses: list[str] = []
        params: list[Any] = []
        if session_id:
            clauses.append("session_id = ?")
            params.append(session_id)
        if kind:
            clauses.append("kind = ?")
            params.append(kind)
        if clauses:
            sql += " WHERE " + " AND ".join(clauses)
        sql += " ORDER BY event_at DESC, received_at DESC LIMIT ?"
        params.append(max(1, limit))

        rows = self.db.conn.execute(sql, params).fetchall()
        return [
            {
                "receivedAt": row["received_at"],
                "envelope": json.loads(row["envelope"]),
                "meta": {},
            }
            for row in rows
        ]

    def state(self, session_id: str) -> dict[str, Any] | None:
        row = self.db.conn.execute(
            "SELECT state FROM session_state WHERE session_id = ?", (session_id,)
        ).fetchone()
        return json.loads(row["state"]) if row else None

    def sessions(self) -> list[dict[str, Any]]:
        rows = self.db.conn.execute(
            "SELECT state FROM session_state ORDER BY updated_at DESC"
        ).fetchall()
        return [json.loads(row["state"]) for row in rows]

    def stats(self) -> dict[str, Any]:
        milestones = self.db.conn.execute("SELECT COUNT(*) AS n FROM milestones").fetchone()["n"]
        sessions = self.db.conn.execute("SELECT COUNT(*) AS n FROM session_state").fetchone()["n"]
        users = self.db.conn.execute("SELECT COUNT(*) AS n FROM users").fetchone()["n"]
        return {
            "milestones": milestones,
            "sessions": sessions,
            "users": users,
            "db": str(self.db.path),
        }

    # ------------------------------------------------------------------- 维护

    def clear_milestones(self) -> int:
        conn = self.db.conn
        count = conn.execute("SELECT COUNT(*) AS n FROM milestones").fetchone()["n"]
        with conn:
            conn.execute("DELETE FROM milestones")
            conn.execute("DELETE FROM session_state")
        return count
