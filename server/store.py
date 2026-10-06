"""里程碑存储：内存索引 + JSONL 落盘。

设计约束（对应 docs/progress-sync-design.md）：
- 以 ``deliveryId`` 做幂等去重：重复投递返回 duplicate，不重复写入。
- 每条里程碑同时保留「事件」与「任务快照」，服务端既能渲染看板也能回放时间线。
- 纯标准库实现，线程安全（Flask 开发服务器是多线程的）。
"""

from __future__ import annotations

import json
import threading
import time
from pathlib import Path
from typing import Any

DEFAULT_MAX_MILESTONES = 2000


def _now_ms() -> int:
    return int(time.time() * 1000)


def _event_time(record: dict[str, Any]) -> tuple[int, int]:
    """里程碑的事件时间（投影时刻），到达时间仅作为同毫秒的次级排序键。"""
    envelope = record.get("envelope") or {}
    milestone = envelope.get("milestone") or {}
    at = milestone.get("at") or envelope.get("emittedAt") or 0
    try:
        return (int(at), int(record.get("receivedAt") or 0))
    except (TypeError, ValueError):
        return (0, 0)


class MilestoneStore:
    """内存 + JSONL 双写的里程碑仓库。"""

    def __init__(self, data_dir: Path, max_milestones: int = DEFAULT_MAX_MILESTONES) -> None:
        self._data_dir = Path(data_dir)
        self._jsonl = self._data_dir / "milestones.jsonl"
        self._max = max_milestones
        self._lock = threading.RLock()
        self._deliveries: set[str] = set()
        self._items: list[dict[str, Any]] = []
        self._state: dict[str, dict[str, Any]] = {}
        self._started_at = _now_ms()

    # ---------------------------------------------------------------- 生命周期

    def load(self) -> int:
        """从 JSONL 恢复历史（进程重启后仍能看到旧里程碑）。"""
        if not self._jsonl.exists():
            return 0
        restored = 0
        with self._lock:
            for line in self._jsonl.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue  # 跳过损坏行，不让历史脏数据阻断启动
                envelope = record.get("envelope") or {}
                delivery_id = envelope.get("deliveryId")
                if isinstance(delivery_id, str):
                    self._deliveries.add(delivery_id)
                self._items.append(record)
                self._apply_state(envelope)
                restored += 1
            if len(self._items) > self._max:
                self._items = self._items[-self._max :]
        return restored

    @property
    def started_at(self) -> int:
        return self._started_at

    # ------------------------------------------------------------------- 写入

    def is_duplicate(self, delivery_id: str | None) -> bool:
        if not delivery_id:
            return False
        with self._lock:
            return delivery_id in self._deliveries

    def append(self, envelope: dict[str, Any], meta: dict[str, Any] | None = None) -> dict[str, Any]:
        """写入一条里程碑，返回落库后的记录。"""
        record = {
            "receivedAt": _now_ms(),
            "envelope": envelope,
            "meta": meta or {},
        }
        with self._lock:
            delivery_id = envelope.get("deliveryId")
            if isinstance(delivery_id, str):
                self._deliveries.add(delivery_id)
            self._items.append(record)
            if len(self._items) > self._max:
                self._items = self._items[-self._max :]
            self._apply_state(envelope)
            self._data_dir.mkdir(parents=True, exist_ok=True)
            with self._jsonl.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(record, ensure_ascii=False) + "\n")
        return record

    def _apply_state(self, envelope: dict[str, Any]) -> None:
        """把里程碑折叠成「会话当前状态」快照。"""
        session = envelope.get("session") or {}
        session_id = session.get("id")
        if not session_id:
            return
        milestone = envelope.get("milestone") or {}
        task = envelope.get("task") or {}

        current = self._state.setdefault(
            session_id,
            {
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
            },
        )
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

    # ------------------------------------------------------------------- 读取

    def milestones(
        self,
        limit: int = 50,
        session_id: str | None = None,
        kind: str | None = None,
    ) -> list[dict[str, Any]]:
        """按时间倒序返回里程碑（最新在前）。"""
        with self._lock:
            items = list(self._items)
        if session_id:
            items = [i for i in items if (i.get("envelope", {}).get("session") or {}).get("id") == session_id]
        if kind:
            items = [i for i in items if (i.get("envelope", {}).get("milestone") or {}).get("kind") == kind]
        # 按「事件时间」而非到达顺序排序：合并窗口会让同一批里程碑乱序到达，
        # 时间线必须还原真实发生顺序（milestone.at 在投影时就已确定）。
        items.sort(key=_event_time, reverse=True)
        return items[: max(1, limit)]

    def state(self, session_id: str | None = None) -> dict[str, Any] | None:
        with self._lock:
            if session_id is None:
                return None
            snap = self._state.get(session_id)
            return json.loads(json.dumps(snap, ensure_ascii=False)) if snap else None

    def sessions(self) -> list[dict[str, Any]]:
        with self._lock:
            return [json.loads(json.dumps(v, ensure_ascii=False)) for v in self._state.values()]

    def stats(self) -> dict[str, Any]:
        with self._lock:
            return {
                "milestones": len(self._items),
                "sessions": len(self._state),
                "uptimeMs": _now_ms() - self._started_at,
                "jsonl": str(self._jsonl),
            }
