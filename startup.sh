#!/bin/sh
set -eu
cd /workspace

start_tick() {
  if [ -f /tmp/meridian-tick.pid ] && kill -0 "$(cat /tmp/meridian-tick.pid)" 2>/dev/null; then
    return 0
  fi
  (
    while true; do
      curl -sf --max-time 45 http://127.0.0.1:8080/api/tick >/dev/null || true
      sleep 12
    done
  ) >/tmp/meridian-tick.log 2>&1 &
  echo $! >/tmp/meridian-tick.pid
}

if curl -sf -o /dev/null --max-time 2 http://127.0.0.1:8080/; then
  start_tick
  exit 0
fi

npm run dev >/tmp/meridian-dev.log 2>&1 &

i=0
while [ "$i" -lt 80 ]; do
  if curl -sf -o /dev/null --max-time 2 http://127.0.0.1:8080/; then
    start_tick
    exit 0
  fi
  i=$((i + 1))
  sleep 0.25
done

exit 1
