"""WSGI 入口。

生产：
    gunicorn -w 2 -k gthread --threads 4 -b 0.0.0.0:8787 dsh_progress.wsgi:app
容器镜像里就是这么起的。
"""

from . import create_app

app = create_app()
