"""命令行管理工具（``dsh-progress``）。

注册在 Web 端是关闭的，账号只能由这里创建 —— 对应「仅管理员建号」的部署方式。
"""

from __future__ import annotations

import argparse
import getpass
import sys
from typing import Any

from . import __version__, create_app
from . import auth
from .config import Config, resolve_static_dir
from .db import Database
from .store import MilestoneStore


def _load() -> tuple[Config, Database, MilestoneStore]:
    config = Config.from_env()
    db = Database(config.db_path)
    db.initialize(legacy_jsonl=config.data_dir / "milestones.jsonl")
    return config, db, MilestoneStore(db)


def _read_password(args: argparse.Namespace) -> str:
    if getattr(args, "password", None):
        return args.password
    first = getpass.getpass("密码: ")
    second = getpass.getpass("确认密码: ")
    if first != second:
        print("两次输入不一致", file=sys.stderr)
        raise SystemExit(2)
    return first


def _ok(message: str) -> None:
    print(f"✓ {message}")


# --------------------------------------------------------------------- 子命令


def cmd_create_user(args: argparse.Namespace) -> int:
    _, db, _ = _load()
    password = _read_password(args)

    is_admin = args.admin
    if not auth.list_users(db):
        # 首个账号必须是管理员，否则无人能再建号
        is_admin = True
        print("（这是第一个账号，已自动设为管理员）")

    try:
        user = auth.create_user(
            db, args.username, password, is_admin=is_admin, display_name=args.display_name
        )
    except auth.AuthError as exc:
        print(f"✗ {exc}", file=sys.stderr)
        return 1

    role = "管理员" if user["isAdmin"] else "普通用户"
    _ok(f"已创建 {role} {user['username']}（id={user['id']}）")
    return 0


def cmd_list_users(_args: argparse.Namespace) -> int:
    _, db, _ = _load()
    users = auth.list_users(db)
    if not users:
        print("还没有任何账号。用 dsh-progress create-user <用户名> 创建第一个。")
        return 0
    print(f"{'ID':<4} {'用户名':<20} {'角色':<8} {'创建时间':<22} 最后登录")
    for user in users:
        from datetime import datetime

        created = datetime.fromtimestamp(user["createdAt"] / 1000).strftime("%Y-%m-%d %H:%M:%S")
        last = (
            datetime.fromtimestamp(user["lastLoginAt"] / 1000).strftime("%Y-%m-%d %H:%M:%S")
            if user["lastLoginAt"]
            else "从未"
        )
        role = "管理员" if user["isAdmin"] else "普通"
        print(f"{user['id']:<4} {user['username']:<20} {role:<8} {created:<22} {last}")
    return 0


def cmd_set_password(args: argparse.Namespace) -> int:
    _, db, _ = _load()
    password = _read_password(args)
    try:
        changed = auth.set_password(db, args.username, password)
    except auth.AuthError as exc:
        print(f"✗ {exc}", file=sys.stderr)
        return 1
    if not changed:
        print(f"✗ 用户不存在：{args.username}", file=sys.stderr)
        return 1
    _ok(f"已更新 {args.username} 的密码，该用户的所有登录会话已吊销")
    return 0


def cmd_delete_user(args: argparse.Namespace) -> int:
    _, db, _ = _load()
    row = auth.find_user(db, args.username)
    if not row:
        print(f"✗ 用户不存在：{args.username}", file=sys.stderr)
        return 1
    if row["is_admin"] and auth.count_admins(db) <= 1:
        print("✗ 不能删除最后一个管理员", file=sys.stderr)
        return 1
    auth.delete_user(db, args.username)
    _ok(f"已删除用户 {args.username}")
    return 0


def cmd_show_token(args: argparse.Namespace) -> int:
    config, db, _ = _load()
    token = auth.current_ingest_token(db, config)
    print(token)
    if args.snippet:
        base = args.endpoint.rstrip("/")
        print()
        print("# 追加到 $DSH_HOME/profiles/<profile>/cordis.patch.yml")
        print("- insert:")
        print("    - id: progress-sync")
        print('      name: "/absolute/path/to/plugin/src/index.js"')
        print("      config:")
        print(f"        endpoint: {base}")
        print(f"        token: {token}")
    return 0


def cmd_rotate_token(args: argparse.Namespace) -> int:
    config, db, _ = _load()
    try:
        token = auth.rotate_ingest_token(db, config)
    except auth.AuthError as exc:
        print(f"✗ {exc}", file=sys.stderr)
        return 1
    _ok("已轮换摄入令牌，旧令牌立即失效（记得同步更新插件配置）")
    print(token)
    return 0


def cmd_clear_milestones(args: argparse.Namespace) -> int:
    _, _, store = _load()
    stats = store.stats()
    if not args.yes:
        answer = input(f"将删除全部 {stats['milestones']} 条里程碑与状态快照，确认？输入 yes 继续: ")
        if answer.strip() != "yes":
            print("已取消")
            return 0
    removed = store.clear_milestones()
    _ok(f"已删除 {removed} 条里程碑")
    return 0


def cmd_rebuild_state(_args: argparse.Namespace) -> int:
    _, db, _ = _load()
    count = db.rebuild_state()
    _ok(f"已按事件时间重建 {count} 个会话的状态快照")
    return 0


def cmd_info(_args: argparse.Namespace) -> int:
    config, db, store = _load()
    stats = store.stats()
    users = auth.list_users(db)
    static_dir = resolve_static_dir(config)
    print(f"版本        {__version__}")
    print(f"数据目录    {config.data_dir}")
    print(f"数据库      {config.db_path}")
    print(f"静态资源    {static_dir}（{'已就绪' if (static_dir / 'index.html').is_file() else '缺失'}）")
    print(f"里程碑      {stats['milestones']}")
    print(f"会话快照    {stats['sessions']}")
    print(f"账号        {len(users)}（管理员 {sum(1 for u in users if u['isAdmin'])}）")
    print(f"摄入鉴权    {'环境变量固定' if config.ingest_token else '数据库持久化'}"
          f"{' + HMAC 兼容' if config.hmac_secret else ''}")
    print(f"签名校验    {'开启' if config.hmac_secret else '关闭'}")
    return 0


def cmd_serve(args: argparse.Namespace) -> int:
    from . import create_app as _create_app

    config = Config.from_env()
    app = _create_app(config)
    print(f"开发服务器 → http://{args.host or config.host}:{args.port or config.port}")
    app.run(host=args.host or config.host, port=args.port or config.port, threaded=True)
    return 0


# ------------------------------------------------------------------------ 入口


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="dsh-progress",
        description="DSH 开发进度同步服务 · 管理工具",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="示例：\n"
        "  dsh-progress create-user admin --admin\n"
        "  dsh-progress show-token --snippet --endpoint https://progress.example.com\n"
        "  dsh-progress info\n",
    )
    parser.add_argument("--version", action="version", version=f"dsh-progress {__version__}")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("create-user", help="创建账号（注册在 Web 端已关闭）")
    p.add_argument("username")
    p.add_argument("--password", help="不传则交互式输入")
    p.add_argument("--admin", action="store_true", help="设为管理员")
    p.add_argument("--display-name")
    p.set_defaults(func=cmd_create_user)

    p = sub.add_parser("list-users", help="列出账号")
    p.set_defaults(func=cmd_list_users)

    p = sub.add_parser("set-password", help="修改密码（会吊销该用户所有登录会话）")
    p.add_argument("username")
    p.add_argument("--password")
    p.set_defaults(func=cmd_set_password)

    p = sub.add_parser("delete-user", help="删除账号")
    p.add_argument("username")
    p.set_defaults(func=cmd_delete_user)

    p = sub.add_parser("show-token", help="显示摄入令牌（插件用）")
    p.add_argument("--snippet", action="store_true", help="同时输出插件配置片段")
    p.add_argument("--endpoint", default="http://127.0.0.1:8787", help="片段里的服务地址")
    p.set_defaults(func=cmd_show_token)

    p = sub.add_parser("rotate-token", help="轮换摄入令牌")
    p.set_defaults(func=cmd_rotate_token)

    p = sub.add_parser("clear-milestones", help="清空全部里程碑")
    p.add_argument("--yes", action="store_true", help="跳过确认")
    p.set_defaults(func=cmd_clear_milestones)

    p = sub.add_parser("rebuild-state", help="按事件时间重建会话状态快照")
    p.set_defaults(func=cmd_rebuild_state)

    p = sub.add_parser("info", help="显示部署与数据概况")
    p.set_defaults(func=cmd_info)

    p = sub.add_parser("serve", help="启动开发服务器（生产请用 gunicorn）")
    p.add_argument("--host")
    p.add_argument("--port", type=int)
    p.set_defaults(func=cmd_serve)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return int(args.func(args) or 0)
    except KeyboardInterrupt:
        print("\n已中断", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
