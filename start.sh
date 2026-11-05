#!/usr/bin/env bash
# 启动斗地主决策助手的展示页服务（FastAPI + uvicorn）。
# 用法：
#   ./start.sh                    # 默认 127.0.0.1:8000
#   ./start.sh --host 0.0.0.0 --port 9000
set -euo pipefail

cd "$(dirname "$0")"

PY=".venv/bin/python"
if [[ ! -x "$PY" ]]; then
  echo "找不到虚拟环境，请先运行：" >&2
  echo "  python3 -m venv .venv && .venv/bin/python -m pip install -r requirements.lock.txt" >&2
  exit 1
fi

# 模型权重缺失时提醒（服务仍会起，但推理会失败）。
if [[ ! -d models/douzero_WP ]]; then
  echo "提示：未发现模型权重，推理相关功能会报错。" >&2
  echo "      可运行： .venv/bin/python scripts/download_models.py" >&2
fi

exec "$PY" -m ddz serve "$@"
