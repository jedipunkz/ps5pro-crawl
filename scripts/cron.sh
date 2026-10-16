#!/usr/bin/env bash
# cron から在庫チェックを 1 回実行する。
# 設定は リポジトリ直下の .env から読む（.env.example 参照）。
# 引数はそのまま src/index.js に渡す（例: --dry-run）。
set -euo pipefail

cd "$(dirname "$0")/.."

# 前回の実行が長引いても多重起動させない
exec 9>.state.lock
if ! flock -n 9; then
  echo "前回の実行が終わっていないためスキップ" >&2
  exit 0
fi

exec node --env-file=.env src/index.js "$@"
