#!/bin/sh
# CF Manager container entrypoint
# ------------------------------------------------------------
# 背景：node:24-alpine 镜像内的 node 用户 UID/GID 固定为 1000。
# 宿主机 ./data 通过 volume 挂载到 /app/data，若宿主属主不是 1000:1000，
# node 进程启动时 better-sqlite3 会 EACCES 导致容器秒退（"无法升级"）。
#
# 此脚本以 root 启动，先修复持久数据目录的属主，再 su-exec drop 到 node 执行 CMD。
# 进程以 node 身份运行，最小特权依旧保留（写 /app/data 之外只读系统）。
# ------------------------------------------------------------
set -eu

# DB_PATH 是文件路径，dirname 才是目录。允许通过 DB_PATH_DIR 直接覆盖以便自定义。
if [ -n "${DB_PATH_DIR:-}" ]; then
  DATA_DIR="$DB_PATH_DIR"
elif [ -n "${DB_PATH:-}" ]; then
  DATA_DIR=$(dirname "$DB_PATH")
else
  DATA_DIR="/app/data"
fi

# 修复挂载目录的属主。宿主属主本就是 1000:1000 时是空操作，开销可忽略。
# || true 避免 set -e 因挂载为只读卷等边缘场景提前退出。
if [ -d "$DATA_DIR" ]; then
  chown -R node:node "$DATA_DIR" || true
fi

# 应用代码与依赖保持只读；运行时数据库和日志写入上面的数据目录。

# 用 su-exec drop 到 node 执行 CMD。su-exec 不杀 shell、正确转发信号，
# 是 Alpine 上 gosu 的标准替代。
if ! command -v su-exec >/dev/null 2>&1; then
  echo "[entrypoint] FATAL: su-exec not found" >&2
  exit 1
fi

exec su-exec node "$@"
