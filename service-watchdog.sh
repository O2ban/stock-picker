#!/usr/bin/env bash
# stock-picker service watchdog
# 职责：每小时探测 localhost:3100/api/health，不通则 nohup npm start 拉起
# 触发：crontab 每小时第 5 分（见 crontab -l）
PROJECT=/home/ubuntu/stock-picker
LOG=$PROJECT/service-watchdog.log
mkdir -p "$PROJECT"

STAMP=$(date '+%Y-%m-%d %H:%M:%S')

{
  echo "===== [$STAMP] cron tick ====="

  if curl -fsS -m 5 http://localhost:3100/api/health >/dev/null 2>&1; then
    echo "[OK] service healthy"
  else
    echo "[WARN] service unreachable, trying restart"
    (cd "$PROJECT" && nohup npm start >> stock-picker.log 2>&1 &)
    sleep 3
    curl -fsS -m 5 http://localhost:3100/api/health >/dev/null 2>&1 && echo "[OK] restarted" || echo "[FAIL] restart failed"
  fi

  echo "[LOG] pid: $(pgrep -f 'node src/server.js' | head -1 || echo 'none')"

  echo ""
} >> "$LOG"
