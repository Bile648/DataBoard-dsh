"""运行时配置：全部来自环境变量，便于容器化部署。"""

from __future__ import annotations

import os
import secrets
from dataclasses import dataclass
from pathlib import Path

TRUTHY = {"1", "true", "yes", "on"}


def _bool(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in TRUTHY


def _int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        return int(raw)
    except ValueError:
        return default


@dataclass(frozen=True)
class Config:
    """进程级配置。字段名与部署文档中的环境变量一一对应。"""

    host: str
    port: int
    data_dir: Path
    db_path: Path
    static_dir: Path
    # 摄入鉴权：Bearer 令牌（留空则首次启动自动生成并持久化到数据库）
    ingest_token: str
    # 兼容旧版插件的 HMAC 签名密钥（可选，与令牌二选一即可通过）
    hmac_secret: str
    max_skew_seconds: int
    # 登录会话
    session_ttl_seconds: int
    secure_cookie: bool
    # 反向代理场景下用于生成正确的外部地址
    trust_proxy: bool
    log_level: str

    @classmethod
    def from_env(cls, base_dir: Path | None = None) -> "Config":
        root = base_dir or Path(__file__).resolve().parent.parent
        data_dir = Path(os.environ.get("DSH_PROGRESS_DATA") or (root / "data"))
        static_dir = Path(os.environ.get("DSH_PROGRESS_STATIC") or (root / "static"))
        return cls(
            host=os.environ.get("DSH_PROGRESS_HOST", "0.0.0.0"),
            port=_int("DSH_PROGRESS_PORT", 8787),
            data_dir=data_dir,
            db_path=Path(os.environ.get("DSH_PROGRESS_DB") or (data_dir / "progress.db")),
            static_dir=static_dir,
            ingest_token=os.environ.get("DSH_PROGRESS_INGEST_TOKEN", "").strip(),
            hmac_secret=os.environ.get("DSH_PROGRESS_SECRET", ""),
            max_skew_seconds=_int("DSH_PROGRESS_MAX_SKEW", 300),
            session_ttl_seconds=_int("DSH_PROGRESS_SESSION_TTL", 7 * 24 * 3600),
            secure_cookie=_bool("DSH_PROGRESS_SECURE_COOKIE", False),
            trust_proxy=_bool("DSH_PROGRESS_TRUST_PROXY", False),
            log_level=os.environ.get("DSH_PROGRESS_LOG_LEVEL", "INFO").upper(),
        )


def new_token(prefix: str = "dshp") -> str:
    """生成不可猜测的随机令牌。"""
    return f"{prefix}_{secrets.token_urlsafe(32)}"


def resolve_static_dir(config: "Config") -> Path:
    """解析前端静态资源目录。

    两种部署形态都要能工作：
    - 源码运行：前端构建到 ``<repo>/server/static``
    - pip / 容器安装：产物随包发布在 ``dsh_progress/static``

    注意 CLI 与应用必须用同一个解析函数，否则像 ``info`` 这样的诊断会误报「缺失」。
    """
    if (config.static_dir / "index.html").is_file():
        return config.static_dir
    packaged = Path(__file__).resolve().parent / "static"
    if (packaged / "index.html").is_file():
        return packaged
    return config.static_dir
