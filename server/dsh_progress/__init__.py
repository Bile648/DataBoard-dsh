"""DSH 开发进度同步服务（后端）。

应用工厂在这里；路由、存储、认证分别见 ``api`` / ``store`` / ``auth``。
生产部署用 WSGI 入口 ``dsh_progress.wsgi:app``（gunicorn 等）。
"""

from __future__ import annotations

import logging
import time
from dataclasses import replace
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory
from werkzeug.exceptions import NotFound

from . import api
from .config import Config, resolve_static_dir
from .db import Database

__version__ = "1.0.0"
__all__ = ["create_app", "Config", "Database", "__version__"]

log = logging.getLogger("dsh_progress")


def create_app(config: Config | None = None, db: Database | None = None) -> Flask:
    config = config or Config.from_env()
    config.data_dir.mkdir(parents=True, exist_ok=True)

    # 静态资源：源码运行走 server/static，pip/容器安装走包内 dsh_progress/static
    static_dir = resolve_static_dir(config)
    if static_dir != config.static_dir:
        config = replace(config, static_dir=static_dir)

    database = db or Database(config.db_path)

    # 旧版 JSONL 数据在首次启动时自动迁移进 SQLite
    migration = database.initialize(legacy_jsonl=config.data_dir / "milestones.jsonl")
    purged = database.purge_sessions()

    app = Flask(__name__, static_folder=None)
    app.config["MAX_CONTENT_LENGTH"] = 8 * 1024 * 1024
    app.config["DSH_CONFIG"] = config
    app.config["DSH_DB"] = database

    logging.basicConfig(
        level=config.log_level,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
    )

    if migration["imported"]:
        log.info("已从旧版 JSONL 迁移 %d 条里程碑", migration["imported"])
    if purged:
        log.info("清理过期登录会话 %d 个", purged)

    @app.before_request
    def _bind_request_context():
        # 供各蓝图通过 g.config / g.db 取用
        from flask import g

        g.config = config
        g.db = database

    @app.after_request
    def _security_headers(response):
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Referrer-Policy", "same-origin")
        return response

    @app.get("/healthz")
    def healthz():
        """给容器编排/负载均衡用的最小健康检查（不含任何业务数据）。"""
        return jsonify({"ok": True, "service": api.SERVICE_NAME, "version": __version__, "time": int(time.time() * 1000)})

    api.register(app)
    _register_error_handlers(app)
    _register_spa(app, config.static_dir)

    log.info("数据目录 %s", config.data_dir)
    log.info("数据库   %s", config.db_path)
    log.info("静态资源 %s（%s）", config.static_dir, "已就绪" if (config.static_dir / "index.html").is_file() else "缺失，前端未构建")
    return app


def _register_error_handlers(app: Flask) -> None:
    """接口路径一律返回 JSON，避免前端拿到 HTML 错误页。"""

    def wants_json() -> bool:
        return request.path.startswith(("/api/", "/dsh/"))

    @app.errorhandler(404)
    def _not_found(_error):
        if wants_json():
            return jsonify({"ok": False, "error": "接口不存在"}), 404
        return _spa_index(app)

    @app.errorhandler(405)
    def _method_not_allowed(_error):
        return jsonify({"ok": False, "error": "方法不允许"}), 405

    @app.errorhandler(413)
    def _too_large(_error):
        return jsonify({"ok": False, "error": "请求体过大"}), 413

    @app.errorhandler(500)
    def _server_error(error):
        log.exception("未处理异常: %s", error)
        return jsonify({"ok": False, "error": "服务内部错误"}), 500


def _spa_index(app: Flask):
    static_dir: Path = app.config["DSH_CONFIG"].static_dir
    index = static_dir / "index.html"
    if not index.is_file():
        return (
            jsonify(
                {
                    "ok": False,
                    "error": "前端资源缺失：请在 web/ 执行 npm run build，或使用官方容器镜像。",
                }
            ),
            503,
        )
    response = send_from_directory(static_dir, "index.html")
    response.headers["Cache-Control"] = "no-cache"
    return response


def _register_spa(app: Flask, static_dir: Path) -> None:
    """托管构建后的单页应用：命中静态文件就直出，否则回落到 index.html。"""

    @app.route("/", defaults={"path": ""})
    @app.route("/<path:path>")
    def spa(path: str):
        if path.startswith(("api/", "dsh/")):
            return jsonify({"ok": False, "error": "接口不存在"}), 404
        if path:
            try:
                response = send_from_directory(static_dir, path)
            except NotFound:
                pass
            else:
                # Vite 产物带内容哈希，可长期缓存
                if path.startswith("assets/"):
                    response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
                return response
        return _spa_index(app)
