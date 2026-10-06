# ---------------------------------------------------------------------------
# 阶段 1：构建前端（产出静态资源，随后被塞进 Python 包）
# ---------------------------------------------------------------------------
FROM node:22-alpine AS web

WORKDIR /build/web
# 先只拷清单，让依赖层可被缓存
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-fund --no-audit

COPY web/ ./
# vite.config.ts 里 outDir 指向 ../server/static
RUN npm run build


# ---------------------------------------------------------------------------
# 阶段 2：运行时
# ---------------------------------------------------------------------------
FROM python:3.12-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# 前端产物先放进包目录，pip 会按 package-data 一起装进 site-packages，
# 于是 create_app 的静态目录回落在任何安装方式下都能找到它。
COPY server/pyproject.toml server/README.md /src/server/
COPY server/dsh_progress /src/server/dsh_progress
COPY --from=web /build/server/static /src/server/dsh_progress/static

RUN pip install /src/server && rm -rf /src

# 非 root 运行
RUN useradd --system --uid 10001 --create-home app \
    && mkdir -p /data \
    && chown -R app:app /data

USER app

ENV DSH_PROGRESS_HOST=0.0.0.0 \
    DSH_PROGRESS_PORT=8787 \
    DSH_PROGRESS_DATA=/data \
    DSH_PROGRESS_LOG_LEVEL=INFO

EXPOSE 8787
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD python -c "import sys,urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8787/healthz', timeout=2).status == 200 else 1)"

# 单进程 + 多线程：SQLite 用 WAL，单进程可彻底避免多进程写锁竞争；
# 本服务的写入量（里程碑上报）很低，8 线程足够。
CMD ["gunicorn", \
     "--workers", "1", \
     "--worker-class", "gthread", \
     "--threads", "8", \
     "--bind", "0.0.0.0:8787", \
     "--access-logfile", "-", \
     "--error-logfile", "-", \
     "dsh_progress.wsgi:app"]
