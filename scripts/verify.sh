#!/bin/sh
set -e
ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PID_FILE="$ROOT/pebble-logs.pid"
LOG_FILE="$ROOT/pebble-logs.txt"

stop_logs() {
	if [ -f "$PID_FILE" ]; then
		pid="$(cat "$PID_FILE")"
		kill "$pid" 2>/dev/null || true
		rm -f "$PID_FILE"
	fi
}

trap stop_logs EXIT INT TERM

pebble build

PYTHONUNBUFFERED=1 pebble logs --emulator emery > "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"
sleep 8

install_and_shot() {
	pebble install --emulator emery
	sleep 5
	pebble screenshot --no-open --emulator emery screenshot_emery.png
}

if ! install_and_shot; then
	stop_logs
	pebble kill || true
	pebble wipe
	PYTHONUNBUFFERED=1 pebble logs --emulator emery > "$LOG_FILE" 2>&1 &
	echo $! > "$PID_FILE"
	sleep 8
	install_and_shot
fi

echo "pbw: $(ls "$ROOT"/build/*.pbw)"
echo "screenshot: $ROOT/screenshot_emery.png"
