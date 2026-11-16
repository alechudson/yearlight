#!/bin/sh
# Rebuild store/yearlight-emery.gif and store/yearlight-gabbro.gif from the emulator.
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Two consecutive frames per theme, in theme order, across one London day.
# Mid-November sunrise is about 07:20 and sunset about 16:15.
SLOTS="classic 05:10 classic 07:20 black 09:30 black 11:00 white 12:30 white 14:00 gray 15:20 gray 16:15 black-gray 18:00 black-gray 21:30"
LONDON_LAT=51.5074
LONDON_LON=-0.1278
HOLD_CS=70
MAX_BYTES=1048576

TMP="$(mktemp -d)"
CHROME_PID=""
LOG_PID=""

cleanup() {
	status=$?
	if [ -n "$LOG_PID" ]; then
		kill "$LOG_PID" 2>/dev/null || true
	fi
	if [ -n "$CHROME_PID" ]; then
		kill "$CHROME_PID" 2>/dev/null || true
	fi
	rm -rf "$TMP" 2>/dev/null || true
	exit "$status"
}
trap cleanup EXIT INT TERM

need() {
	if ! command -v "$1" >/dev/null 2>&1; then
		echo "missing $1" >&2
		exit 1
	fi
}

need pebble
need node
need ffmpeg
need python3
if command -v google-chrome >/dev/null 2>&1; then
	CHROME=google-chrome
elif command -v google-chrome-stable >/dev/null 2>&1; then
	CHROME=google-chrome-stable
else
	echo "missing google-chrome" >&2
	exit 1
fi

PY="$(sed -n '1s/^#!//p' "$(command -v pebble)")"
if [ ! -x "$PY" ]; then
	PY=python3
fi

REAL_QEMU="$(find "$HOME/.local/share/pebble-sdk/SDKs" -type f -name qemu-pebble -print | sort | tail -n 1)"
FAKE_SO="$(find /usr/lib -type f -name libfaketimeMT.so.1 -print | head -n 1)"
if [ -z "$REAL_QEMU" ] || [ -z "$FAKE_SO" ]; then
	echo "need qemu-pebble from the Pebble SDK and libfaketime" >&2
	exit 1
fi
CLOCK="$TMP/clock"
# +0 keeps the first boot on the real clock so the phone can fetch the forecast.
echo '+0 x1' >"$CLOCK"
cat >"$TMP/qemu-pebble" <<EOF
#!/usr/bin/env python3
import os, sys
os.environ["LD_PRELOAD"] = "$FAKE_SO"
os.environ["FAKETIME_TIMESTAMP_FILE"] = "$CLOCK"
os.environ["FAKETIME_NO_CACHE"] = "1"
os.environ["FAKETIME_DONT_FAKE_MONOTONIC"] = "1"
os.environ["TZ"] = "Europe/London"
qemu = "$REAL_QEMU"
os.execv(qemu, [qemu] + sys.argv[1:])
EOF
chmod +x "$TMP/qemu-pebble"
export PEBBLE_QEMU_PATH="$TMP/qemu-pebble"
cat >"$TMP/set-clock.py" <<'PY'
import sys
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

clock, hh, mm = sys.argv[1:]
london = ZoneInfo("Europe/London")
now = datetime.now(london)
# Yesterday stays behind the phone's forecast timestamp, so the face does not
# draw the stale mark while the sun still follows this clock.
target = (now - timedelta(days=1)).replace(hour=int(hh), minute=int(mm), second=0, microsecond=0)
delta = int((target - now).total_seconds())
with open(clock, "w") as fh:
    fh.write(f"{delta:+d} x1\n")
PY

pebble build

CHROME_PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')"
"$CHROME" --headless=new --disable-gpu --no-sandbox --disable-dev-shm-usage \
	--remote-debugging-port="$CHROME_PORT" --remote-allow-origins=* \
	--user-data-dir="$TMP/chrome" about:blank >"$TMP/chrome.log" 2>&1 &
CHROME_PID=$!
i=0
while [ "$i" -lt 50 ]; do
	if curl -sf "http://127.0.0.1:$CHROME_PORT/json/version" >/dev/null; then
		break
	fi
	i=$((i + 1))
	sleep 0.1
done
curl -sf "http://127.0.0.1:$CHROME_PORT/json/version" >/dev/null

cat >"$TMP/save-theme.mjs" <<'EOF'
import fs from 'fs';
import http from 'http';

const [platform, theme, chromePort] = process.argv.slice(2);
const info = JSON.parse(fs.readFileSync('/tmp/pb-emulator.json', 'utf8'));
const versions = info[platform];
const version = Object.keys(versions).find((key) => versions[key].pypkjs);
const phonePort = versions[version].pypkjs.port;

function httpReq(method, path) {
	return new Promise((resolve, reject) => {
		const req = http.request({ host: '127.0.0.1', port: chromePort, path, method }, (res) => {
			let body = '';
			res.on('data', (chunk) => { body += chunk; });
			res.on('end', () => resolve({ status: res.statusCode, body }));
		});
		req.on('error', reject);
		req.end();
	});
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

const phone = new WebSocket('ws://127.0.0.1:' + phonePort);
phone.binaryType = 'arraybuffer';

function sendPhone(bytes) {
	phone.send(Buffer.from(bytes));
}

let configUrl = null;
phone.onmessage = (event) => {
	const buf = Buffer.from(event.data);
	if (buf[0] === 0x0a && buf[1] === 0x01 && buf.length >= 6) {
		const len = buf.readUInt32BE(2);
		configUrl = buf.subarray(6, 6 + len).toString('utf8');
	}
};

await new Promise((resolve, reject) => {
	phone.onopen = resolve;
	phone.onerror = () => reject(new Error('phone websocket failed'));
});
sendPhone([0x0a, 0x01]);
for (let i = 0; i < 50 && !configUrl; i++) await sleep(100);
if (!configUrl) throw new Error('settings page did not open');

const created = await httpReq('PUT', '/json/new?about:blank');
if (created.status !== 200) throw new Error('chrome tab failed: ' + created.status);
const tab = JSON.parse(created.body);
const page = new WebSocket(tab.webSocketDebuggerUrl);
let nextId = 0;
const pending = new Map();
let closeUrl = null;
page.onmessage = (event) => {
	const msg = JSON.parse(event.data);
	if (msg.id && pending.has(msg.id)) {
		const waiter = pending.get(msg.id);
		pending.delete(msg.id);
		if (msg.error) waiter.reject(new Error(JSON.stringify(msg.error)));
		else waiter.resolve(msg.result);
	} else if (msg.method === 'Page.frameRequestedNavigation' && msg.params.url.startsWith('pebblejs://close#')) {
		// Chrome has no pebblejs handler. The phone app uses this hash as webviewclosed's response.
		closeUrl = msg.params.url;
	}
};
function cdp(method, params) {
	const id = ++nextId;
	return new Promise((resolve, reject) => {
		pending.set(id, { resolve, reject });
		page.send(JSON.stringify({ id, method, params }));
	});
}
await new Promise((resolve, reject) => {
	page.onopen = resolve;
	page.onerror = () => reject(new Error('chrome devtools failed'));
});
await cdp('Page.enable');
await cdp('Runtime.enable');
await cdp('Page.navigate', { url: configUrl });
let ready = false;
for (let i = 0; i < 50; i++) {
	const result = await cdp('Runtime.evaluate', {
		expression: '!!document.querySelector(\'input[name="theme"]\')',
		returnByValue: true,
	});
	if (result.result && result.result.value) {
		ready = true;
		break;
	}
	await sleep(100);
}
if (!ready) throw new Error('settings page has no theme control');
const clicked = await cdp('Runtime.evaluate', {
	expression: `(() => {
		const input = document.querySelector('input[name="theme"][value=' + JSON.stringify(${JSON.stringify(theme)}) + ']');
		if (!input) return 'missing';
		input.click();
		const save = document.getElementById('save');
		if (!save) return 'no-save';
		save.click();
		return 'clicked';
	})()`,
	returnByValue: true,
});
if (!clicked.result || clicked.result.value !== 'clicked') {
	throw new Error('could not save theme ' + theme + ': ' + (clicked.result && clicked.result.value));
}
for (let i = 0; i < 30 && !closeUrl; i++) await sleep(50);
if (!closeUrl) throw new Error('Save did not close the settings page');
const hash = closeUrl.slice('pebblejs://close#'.length);
const chosen = JSON.parse(decodeURIComponent(hash));
if (chosen.theme !== theme || chosen.units !== 'F') {
	throw new Error('settings closed with ' + JSON.stringify(chosen));
}
const body = Buffer.from(hash, 'utf8');
const msg = Buffer.alloc(6 + body.length);
msg[0] = 0x0a;
msg[1] = 0x02;
msg.writeUInt32BE(body.length, 2);
body.copy(msg, 6);
sendPhone(msg);
await sleep(200);
phone.close();
page.close();
await httpReq('GET', '/json/close/' + tab.id);
process.stdout.write(hash + '\n');
EOF

wait_for_london() {
	platform="$1"
	log="$TMP/$platform.log"
	attempt=0
	while [ "$attempt" -lt 3 ]; do
		: >"$log"
		PYTHONUNBUFFERED=1 pebble logs --emulator "$platform" >"$log" 2>&1 &
		LOG_PID=$!
		sleep 1
		if kill -0 "$LOG_PID" 2>/dev/null; then
			pebble install --emulator "$platform"
			i=0
			while [ "$i" -lt 30 ]; do
				if grep -q "51.5074,-0.1278" "$log"; then
					sleep 6
					kill "$LOG_PID" 2>/dev/null || true
					wait "$LOG_PID" 2>/dev/null || true
					LOG_PID=""
					if grep -q "send fail 6" "$log"; then
						echo "forecast never reached the $platform watch" >&2
						cat "$log" >&2
						exit 1
					fi
					return 0
				fi
				if ! kill -0 "$LOG_PID" 2>/dev/null; then
					break
				fi
				i=$((i + 1))
				sleep 1
			done
		fi
		kill "$LOG_PID" 2>/dev/null || true
		wait "$LOG_PID" 2>/dev/null || true
		LOG_PID=""
		attempt=$((attempt + 1))
	done
	echo "London forecast did not arrive on $platform" >&2
	cat "$log" >&2
	exit 1
}

capture_platform() {
	platform="$1"
	width="$2"
	height="$3"
	frames="$TMP/$platform"
	mkdir -p "$frames"
	echo '+0 x1' >"$CLOCK"
	pebble install --emulator "$platform"
	pebble emu-set-location --emulator "$platform" "$LONDON_LAT" "$LONDON_LON"
	wait_for_london "$platform"
	n=0
	# shellcheck disable=SC2086
	set -- $SLOTS
	while [ "$#" -gt 0 ]; do
		theme="$1"
		hhmm="$2"
		shift 2
		hh="${hhmm%:*}"
		mm="${hhmm#*:}"
		# The face reads the emulator clock once, at launch. Set it, then restart.
		python3 "$TMP/set-clock.py" "$CLOCK" "$hh" "$mm"
		pebble kill >/dev/null 2>&1 || true
		sleep 1
		pebble screenshot --no-open --emulator "$platform" "$TMP/warmup.png"
		sleep 1
		saved=0
		try=0
		while [ "$try" -lt 3 ]; do
			if node "$TMP/save-theme.mjs" "$platform" "$theme" "$CHROME_PORT" >"$TMP/close.txt"; then
				saved=1
				break
			fi
			try=$((try + 1))
			sleep 1
		done
		if [ "$saved" -ne 1 ]; then
			echo "could not save theme $theme on $platform" >&2
			exit 1
		fi
		sleep 2
		echo "frame $n $platform $theme $hhmm"
		pebble screenshot --no-open --emulator "$platform" "$frames/$n.png"
		mkdir -p "$ROOT/store/frames"
		cp "$frames/$n.png" "$ROOT/store/frames/$platform-$hhmm-$theme.png"
		n=$((n + 1))
	done
	ffmpeg -y -framerate "100/$HOLD_CS" -start_number 0 -i "$frames/%d.png" \
		-vf "palettegen=reserve_transparent=1:stats_mode=full:max_colors=256" \
		"$frames/palette.png" -v error
	out="$ROOT/store/yearlight-$platform.gif"
	mkdir -p "$ROOT/store"
	ffmpeg -y -framerate "100/$HOLD_CS" -start_number 0 -i "$frames/%d.png" -i "$frames/palette.png" \
		-lavfi "[0:v][1:v]paletteuse=dither=none:diff_mode=rectangle:alpha_threshold=128" \
		-loop 0 "$out" -v error
	"$PY" - "$frames" "$out" "$width" "$height" "$MAX_BYTES" "$HOLD_CS" "$n" <<'PY'
import sys
from pathlib import Path
try:
    from PIL import Image, ImageSequence
except ImportError:
    sys.stderr.write("Pillow is not available next to pebble\n")
    sys.exit(1)
frames = Path(sys.argv[1])
gif_path = Path(sys.argv[2])
width, height, limit = int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5])
hold_ms = int(sys.argv[6]) * 10
count = int(sys.argv[7])
size = gif_path.stat().st_size
if size > limit:
    raise SystemExit(f"{gif_path.name} is {size} bytes")
gif = Image.open(gif_path)
if gif.n_frames != count or gif.size != (width, height):
    raise SystemExit(f"{gif_path.name} is {gif.size} with {gif.n_frames} frames")
if gif.info.get("loop") != 0:
    raise SystemExit(f"{gif_path.name} does not loop forever")
for index, frame in enumerate(ImageSequence.Iterator(gif)):
    if frame.info.get("duration") != hold_ms:
        raise SystemExit(f"{gif_path.name} frame {index} holds {frame.info.get('duration')} ms")
    shot = Image.open(frames / f"{index}.png").convert("RGBA")
    got = frame.convert("RGBA")
    if got.size != shot.size:
        raise SystemExit(f"{gif_path.name} frame {index} size {got.size}")
    sp, gp = shot.load(), got.load()
    for y in range(shot.height):
        for x in range(shot.width):
            src, dst = sp[x, y], gp[x, y]
            # GIF has one transparent index, so the hidden corner color is not kept.
            if src[3] == 0:
                if dst[3] != 0:
                    raise SystemExit(f"{gif_path.name} frame {index} filled a transparent pixel")
            elif dst != src:
                raise SystemExit(f"{gif_path.name} frame {index} changed a theme pixel")
print(f"{gif_path.name} {width}x{height} {count} frames {size} bytes")
PY
}

pebble kill >/dev/null 2>&1 || true
capture_platform emery 200 228
pebble kill >/dev/null 2>&1 || true
capture_platform gabbro 260 260
echo "wrote $ROOT/store/yearlight-emery.gif and $ROOT/store/yearlight-gabbro.gif"
