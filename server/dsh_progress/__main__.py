"""本地开发入口：``python -m dsh_progress``。

生产请用 gunicorn（见 ``dsh_progress.wsgi``）。
"""

from __future__ import annotations

from . import create_app
from .config import Config

if __name__ == "__main__":
    config = Config.from_env()
    app = create_app(config)
    print(f"开发服务器启动 → http://{config.host}:{config.port}")
    app.run(host=config.host, port=config.port, threaded=True, debug=False)
