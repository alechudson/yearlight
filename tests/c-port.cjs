// Holds the native C watchface to the JavaScript face it replaces
// (tests/reference/*.js, Yearlight 1.2.0). Both run the same scripts of time,
// phone messages, timers and quick views; their final frames must match:
// every pixel outside the globe disc and every text draw exactly.
//
// The C globe goes past 1.2.0: one sample per pixel and a finer land mask. So
// the disc is held instead to a plain floating-point globe drawn here, from
// the same mask, place and sun the JavaScript face last shaded with, to
// within the C build's fixed-point land and terminator rounding.
process.env.TZ = 'America/Chicago';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {spawnSync} = require('node:child_process');
const wire = require('./wire.cjs');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(os.tmpdir(), `yearlight-host-${process.pid}`);
const DISC_TOLERANCE = 0.01;
// The battery glyph and its number, which the 1.2.0 JavaScript face does not
// have: [x0, y0, x1, y1), by screen width. The comparison skips them, and the
// battery tests hold every battery pixel inside and the box off the globe.
const BATTERY_BOX = {200: [143, 0, 200, 18], 260: [200, 96, 254, 114]};
const inBatteryBox = (w, x, y) => {
	const [x0, y0, x1, y1] = BATTERY_BOX[w];
	return x >= x0 && x < x1 && y >= y0 && y < y1;
};
// Text boxes whose top-left corner is in the box; tracking splits "80%" into "8" and "0%".
const isBatteryText = w => t => inBatteryBox(w, t[3], t[4]);
const batteryNumber = (w, texts) => texts.filter(isBatteryText(w)).map(t => t[0]).join('');

// ------------------------------------------------------------ the reference globe

const MASK_SRC = fs.readFileSync(path.join(ROOT, 'src/c/worldmask.c'), 'utf8');
const MASK_DIM = fs.readFileSync(path.join(ROOT, 'src/c/tables.h'), 'utf8');
const MASK_W = Number(MASK_DIM.match(/#define MASK_W (\d+)/)[1]);
const MASK_H = Number(MASK_DIM.match(/#define MASK_H (\d+)/)[1]);
const MASK = Uint8Array.from(MASK_SRC.match(/WORLD_MASK\[[^\]]*\] = \{([^}]*)\}/)[1].match(/0x[0-9a-f]{2}/g).map(v => parseInt(v, 16)));
const GLOBE_COLORS = [0xC3, 0xC1, 0xCC, 0xC4];  // day ocean, night ocean, day land, night land
const NIGHT_SIN = Math.sin(-0.833 * Math.PI / 180);

// The globe color of pixel (x, y) for a view origin and sun, or -1 off the disc:
// read at the pixel's center, in doubles, from the C build's mask.
function referenceGlobe([cx, cy, r], origin, sun) {
	const lat0 = origin.lat * Math.PI / 180, lon0 = origin.lon * Math.PI / 180;
	const sinLat0 = Math.sin(lat0), cosLat0 = Math.cos(lat0), sinLon0 = Math.sin(lon0), cosLon0 = Math.cos(lon0);
	const sunX = -sun.cosY * sun.cosX, sunY = -sun.cosY * sun.sinX, sunZ = -sun.sinY;
	const a = sunX * cosLon0 + sunY * sinLon0;
	const vx = sunY * cosLon0 - sunX * sinLon0, vy = sunZ * cosLat0 - a * sinLat0, vz = a * cosLat0 + sunZ * sinLat0;
	return (x, y) => {
		const xn = (x + 0.5 - cx) / r, yn = (cy - (y + 0.5)) / r;
		const rr = xn * xn + yn * yn;
		if (rr > 1) return -1;
		const z = Math.sqrt(1 - rr);
		const lat = Math.asin(Math.max(-1, Math.min(1, yn * cosLat0 + z * sinLat0))) * 180 / Math.PI;
		let lon = (lon0 + Math.atan2(xn, z * cosLat0 - yn * sinLat0)) * 180 / Math.PI;
		lon = ((lon + 180) % 360 + 360) % 360 - 180;
		const mx = Math.min(MASK_W - 1, Math.floor((lon + 180) / 360 * MASK_W));
		const my = Math.min(MASK_H - 1, Math.floor((90 - lat) / 180 * MASK_H));
		const i = my * MASK_W + mx;
		const land = (MASK[i >> 3] >> (i & 7)) & 1;
		const night = vx * xn + vy * yn + vz * z < NIGHT_SIN;
		return GLOBE_COLORS[land * 2 + (night ? 1 : 0)];
	};
}

// BIN leaves out the moon marker, which 1.2.0 did not have; MOON_BIN is the face as shipped.
const MOON_BIN = BIN + '-moon';
const build = (out, defines) => spawnSync('gcc', ['-std=c99', '-Wall', '-Wextra', '-Werror', '-Wno-unused-parameter', '-Os', ...defines,
	'-I', path.join(__dirname, 'c'), ...fs.readdirSync(path.join(ROOT, 'src/c')).filter(f => f.endsWith('.c')).map(f => path.join(ROOT, 'src/c', f)),
	path.join(__dirname, 'c/mock.c'), '-lm', '-o', out], {encoding: 'utf8'});
const built = build(BIN, ['-DYEARLIGHT_NO_MOON']);
const skip = built.error ? 'gcc not available' : false;
for (const result of skip ? [] : [built, build(MOON_BIN, [])])
	if (result.status !== 0)
		throw new Error('host build failed:\n' + result.stderr);
process.on('exit', () => { fs.rmSync(BIN, {force: true}); fs.rmSync(MOON_BIN, {force: true}); });

const argb = (r, g, b) => 0xC0 | ((r >> 6) << 4) | ((g >> 6) << 2) | (b >> 6);
// Text box tops, as the firmware's Poco places them: y - cap + 1.
const CAP = {42: 9, 18: 3, 14: 3};

// ------------------------------------------------------------ the JS reference

function bootJS({w, h, now, hour12, store}) {
	let clock = now;
	const fb = new Uint8Array(w * h);
	let clip = [0, 0, w, h];
	let texts = [];
	const timers = [];
	const events = {};
	let serial = 0;
	let message = null;
	class Clock extends Date {
		constructor(...args) { super(...(args.length ? args : [clock])); }
		static now() { return clock; }
	}
	class Poco {
		constructor() {
			this.Font = class { constructor(name, size) { this.name = name; this.size = size; } };
			this.width = w;
			this.height = h;
			this.unobstructed = {width: w, height: h};
		}
		makeColor(r, g, b) { return argb(r, g, b); }
		begin(x = 0, y = 0, bw = w, bh = h) { clip = [x, y, x + bw, y + bh]; texts = []; }
		end() {}
		fillRectangle(color, x, y, rw, rh) {
			const x0 = Math.max(x, clip[0], 0), x1 = Math.min(x + rw, clip[2], w);
			const y0 = Math.max(y, clip[1], 0), y1 = Math.min(y + rh, clip[3], h);
			for (let py = y0; py < y1; py++)
				fb.fill(color, py * w + x0, py * w + Math.max(x0, x1));
		}
		drawText(text, font, color, x, y) { texts.push([String(text), font.size, color, x, y - CAP[font.size] + 1]); }
		getTextWidth(text, font) { return String(text).length * Math.ceil(font.size * 0.5); }
	}
	class Message {
		constructor(options) { this.options = options; message = this; }
		write() {}
		read() { return this._msg; }
	}
	const context = vm.createContext({
		Poco, Message, screen: {}, Date: Clock, console: {log() {}},
		watch: {hour12, addEventListener(name, fn) { events[name] = fn; }},
		setTimeout(fn, delay) { timers.push({fn, at: clock + (delay || 0), id: ++serial}); return serial; },
		clearTimeout() {},
		localStorage: {
			getItem(k) { return store.has(k) ? store.get(k) : null; },
			setItem(k, v) { store.set(k, String(v)); },
		},
	});
	for (const file of ['worldmask', 'yearstars', 'main']) {
		const source = fs.readFileSync(path.join(__dirname, `reference/${file}.js`), 'utf8')
			.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
		vm.runInContext(source, context);
	}
	const evaluate = code => vm.runInContext(code, context);
	// Every draw repaints the whole HUD, so the last one holds all its texts.
	evaluate('drawScreen = (draw => function (event) { invalidateHud(); return draw(event); })(drawScreen);');
	// The place and sun the globe was last shaded with, for the reference globe.
	evaluate('var lastMap = null; drawMap = (map => function (sun, origin) { lastMap = {sun, origin}; return map(sun, origin); })(drawMap);');
	let lastHour = new Date(clock).getHours();
	return {
		fb, eval: evaluate,
		texts: () => texts,
		setNow(ms) {
			clock = ms;
			events.minutechange({date: new Clock()});
			const hour = new Date(clock).getHours();
			if (hour !== lastHour && events.hourchange)
				events.hourchange();
			lastHour = hour;
		},
		timers() {
			for (;;) {
				const due = timers.filter(t => t.at <= clock).sort((a, b) => a.at - b.at || a.id - b.id)[0];
				if (!due)
					return;
				timers.splice(timers.indexOf(due), 1);
				due.fn();
			}
		},
		msg(theme, payload) {
			message._msg = {get(key) { return key === 'THEME' ? theme ?? undefined : key === 'PAYLOAD' ? payload ?? undefined : undefined; }};
			message.options.onReadable.call(message);
		},
		obstruct(height) {
			evaluate(`render.unobstructed = {width: ${w}, height: ${height}}`);
			events.resize({});
		},
	};
}

// ------------------------------------------------------------ the C build

function runC({w, h, now, hour12, persist}, steps) {
	const lines = [`size ${w} ${h}`, `now ${Math.floor(now / 1000)}`, `hour12 ${hour12 ? 1 : 0}`];
	for (const [key, value] of persist)
		lines.push(typeof value === 'number' ? `persist_int ${key} ${value}`
			: typeof value === 'object' ? `persist_data ${key} ${value.data}` : `persist_str ${key} ${value}`);
	lines.push('start');
	for (const step of steps) {
		if (step[0] === 'now')
			lines.push(`now ${Math.floor(step[1] / 1000)}`, 'tick');
		else if (step[0] === 'timers')
			lines.push('timers');
		else if (step[0] === 'msg')
			lines.push(`msg ${step[1] ?? '-'} ${step[2] ?? '-'}`);
		else if (step[0] === 'obstruct')
			lines.push(`obstruct ${step[1]}`);
		else if (step[0] === 'battery')
			lines.push(`battery ${step[1]} ${step[2] ? 1 : 0}`);
		else if (step[0] === 'check')
			lines.push('frame');
	}
	lines.push('persist');
	const run = spawnSync(BIN, [], {input: lines.join('\n') + '\n', encoding: 'utf8', maxBuffer: 1 << 28, env: {...process.env, TZ: process.env.TZ}});
	if (run.status !== 0)
		throw new Error(`C build exited ${run.status}: ${run.stderr}`);
	const out = run.stdout.trim().split('\n').map(line => JSON.parse(line));
	const store = out.find(o => o.persist);
	return {frames: out.filter(o => o.rects), persist: store.persist, writes: store.writes};
}

function raster(w, h, rects) {
	const fb = new Uint8Array(w * h);
	for (const [color, x, y, rw, rh] of rects) {
		const x0 = Math.max(x, 0), x1 = Math.min(x + rw, w);
		for (let py = Math.max(y, 0); py < Math.min(y + rh, h); py++)
			if (x1 > x0) fb.fill(color, py * w + x0, py * w + x1);
	}
	return fb;
}

// ------------------------------------------------------------ scenarios

const SEC = Date.UTC(2026, 8, 9) / 1000;

function forecast({lat = 30, lon = -97, temp = 82, code = 0, offset = -18000, updatedAt, daily = true} = {}) {
	const weather = {current: {temperature_2m: temp, weather_code: code}, utc_offset_seconds: offset};
	if (daily)
		weather.daily = {time: [SEC - 86400 - offset, SEC - offset, SEC + 86400 - offset],
			sunrise: [SEC - 86400 + 43200, SEC + 43200, SEC + 129600], sunset: [SEC, SEC + 86400, SEC + 172800]};
	return wire({lat, lon, updatedAt, weather});
}

// Runs one session (or several, across relaunches) through both builds.
function scenario({w = 200, h = 228, hour12 = false, start, sessions}) {
	const store = new Map();
	let persist = [];
	const results = [];
	let now = start;
	for (const steps of sessions) {
		const js = bootJS({w, h, now, hour12, store});
		const c = runC({w, h, now, hour12, persist}, steps);
		let frame = 0;
		for (const step of steps) {
			if (step[0] === 'now') { now = step[1]; js.setNow(now); }
			else if (step[0] === 'timers') js.timers();
			else if (step[0] === 'msg') js.msg(step[1], step[2]);
			else if (step[0] === 'obstruct') js.obstruct(step[1]);
			else if (step[0] === 'check') {
				const got = c.frames[frame++];
				results.push({label: step[1], w, h, js: {fb: js.fb.slice(), texts: js.texts().slice()},
					c: {fb: raster(w, h, got.rects), texts: got.texts}, globe: js.eval('[GLOBE_CX, GLOBE_CY, GLOBE_R]'),
					map: js.eval('lastMap && (state.lat !== null || defaultGlobe) ? JSON.stringify(lastMap) : null'), sky: js.eval('theme.sky')});
			}
		}
		persist = c.persist;
	}
	return results;
}

function compare(result) {
	const {w, h, js, c, globe: [cx, cy, r], sky} = result;
	const map = result.map && JSON.parse(result.map);
	const ref = map ? referenceGlobe([cx, cy, r], map.origin, map.sun) : () => -1;
	let disc = 0, discDiff = 0, outsideDiff = 0;
	let firstOutside = null;
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const i = y * w + x;
			const inDisc = (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= (r + 1) ** 2;
			if (!inDisc) {
				if (js.fb[i] === c.fb[i] || inBatteryBox(w, x, y)) continue;
				outsideDiff++;
				firstOutside ??= `(${x},${y}) js ${js.fb[i]} c ${c.fb[i]}`;
				continue;
			}
			disc++;
			// On the disc: globe pixels against the reference globe; anything drawn
			// over it (sun, pin) against the JavaScript face; sky off the 1 px disc.
			const want = ref(x, y);
			const got = c.fb[i];
			if (GLOBE_COLORS.includes(got)) {
				if (got !== want) discDiff++;
			} else if (!(got === js.fb[i] || (want < 0 && got === sky)))
				discDiff++;
		}
	}
	return {disc, discDiff, outsideDiff, firstOutside};
}

function check(results) {
	let worst = 0;
	for (const result of results) {
		assert.deepEqual(result.c.texts.filter(t => !isBatteryText(result.w)(t)), result.js.texts, `${result.label}: texts`);
		const {disc, discDiff, outsideDiff, firstOutside} = compare(result);
		assert.equal(outsideDiff, 0, `${result.label}: ${outsideDiff} pixels outside the globe differ, first ${firstOutside}`);
		assert.ok(discDiff <= disc * DISC_TOLERANCE, `${result.label}: ${discDiff} of ${disc} disc pixels differ`);
		worst = Math.max(worst, discDiff / disc);
	}
	return worst;
}

const T = iso => Date.parse(iso);
const LAYOUTS = [['Time 2', 200, 228, 177], ['Round 2', 260, 260, 157]];

for (const [name, w, h, quick] of LAYOUTS) {
	test(`${name}: a day of the HUD and globe matches the JavaScript face`, {skip}, () => {
		const start = T('2026-09-09T18:00:00Z');
		check(scenario({w, h, start, sessions: [[
			['check', 'boot'],
			['msg', 0, forecast({updatedAt: start})], ['check', 'forecast'],
			['now', T('2026-09-09T18:01:00Z')], ['check', '18:01'],
			['now', T('2026-09-09T18:29:00Z')], ['check', '18:29'],
			['now', T('2026-09-09T18:30:00Z')], ['check', 'terminator step'],
			['now', T('2026-09-09T23:59:00Z')], ['check', 'dusk'],
			['now', T('2026-09-10T01:00:00Z')], ['check', 'after sunset'],
			['now', T('2026-09-10T05:01:00Z')], ['check', 'local midnight'],
			['now', T('2026-09-10T11:00:00Z')], ['check', 'pre-dawn'],
			['now', T('2026-09-10T13:00:00Z')], ['check', 'next morning'],
			['now', T('2026-09-10T21:00:00Z')], ['check', 'stale'],
		]]}));
	});

	test(`${name}: 12-hour time, every theme, every weather icon`, {skip}, () => {
		const start = T('2026-09-09T15:07:00Z');
		const steps = [['msg', 0, forecast({updatedAt: start})], ['check', 'start']];
		for (const theme of [1, 2, 3, 4, 0]) steps.push(['msg', theme, forecast({updatedAt: start})], ['check', `theme ${theme}`]);
		for (const code of [0, 2, 45, 53, 63, 73, 81, 99]) steps.push(['msg', null, forecast({code, temp: code - 20.5, updatedAt: start})], ['check', `code ${code}`]);
		steps.push(['now', T('2026-09-10T03:07:00Z')], ['msg', null, forecast({code: 0, updatedAt: T('2026-09-10T03:00:00Z')})], ['check', 'clear night']);
		check(scenario({w, h, hour12: true, start, sessions: [steps]}));
	});

	test(`${name}: offline, location only, missing daily data and polar days`, {skip}, () => {
		const start = T('2026-06-21T16:00:00Z');
		check(scenario({w, h, start, sessions: [[
			['check', 'loading'],
			['now', T('2026-06-21T16:00:02Z')], ['timers'], ['check', 'default globe'],
			['now', T('2026-06-21T16:00:30Z')], ['timers'], ['check', 'offline'],
			['msg', null, 'E'], ['check', 'error'],
			['msg', null, '51.5,-0.12'], ['check', 'location only (London)'],
			['msg', null, forecast({lat: -33.87, lon: 151.21, offset: 36000, daily: false, updatedAt: start})], ['check', 'no daily data (Sydney)'],
			['msg', null, '78.2,15.6'], ['check', 'polar day'],
			['now', T('2026-12-21T12:00:00Z')], ['check', 'polar night'],
		]]}));
	});

	test(`${name}: quick view and relaunch from storage`, {skip}, () => {
		const start = T('2026-09-09T18:15:00Z');
		check(scenario({w, h, start, sessions: [
			[['msg', 2, forecast({updatedAt: start})], ['obstruct', quick], ['check', 'quick view'],
				['now', T('2026-09-09T18:16:00Z')], ['check', 'quick view tick'], ['obstruct', h], ['check', 'quick view gone']],
			[['timers'], ['check', 'relaunch']],
		]}));
	});

	test(`${name}: the globe across places and seasons`, {skip}, () => {
		let seed = 7;
		const rand = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296;
		const steps = [];
		let time = T('2026-01-01T00:00:00Z');
		for (let i = 0; i < 60; i++) {
			time += Math.floor(rand() * 12 * 86400) * 1000;
			const lat = Math.round((rand() * 170 - 85) * 1e4) / 1e4;
			const lon = Math.round((rand() * 360 - 180) * 1e4) / 1e4;
			steps.push(['now', time - (time % 60000)], ['msg', null, `${lat},${lon}`], ['check', `${lat},${lon} ${new Date(time).toISOString()}`]);
		}
		const worst = check(scenario({w, h, start: T('2026-01-01T00:00:00Z'), sessions: [steps]}));
		process.stdout.write(`# ${name}: worst globe disc difference ${(worst * 100).toFixed(2)}%\n`);
	});

	test(`${name}: twenty cities across the globe, through the seasons and the day`, {skip}, () => {
		const CITIES = [
			['Jerusalem', 31.7683, 35.2137, 7200], ['Tel Aviv', 32.0853, 34.7818, 7200],
			['Reykjavik', 64.1466, -21.9426, 0], ['London', 51.5072, -0.1276, 0],
			['Cairo', 30.0444, 31.2357, 7200], ['Nairobi', -1.2921, 36.8219, 10800],
			['Cape Town', -33.9249, 18.4241, 7200], ['Moscow', 55.7558, 37.6173, 10800],
			['Mumbai', 19.076, 72.8777, 19800], ['Singapore', 1.3521, 103.8198, 28800],
			['Tokyo', 35.6762, 139.6503, 32400], ['Sydney', -33.8688, 151.2093, 39600],
			['Auckland', -36.8485, 174.7633, 46800], ['Honolulu', 21.3069, -157.8583, -36000],
			['Anchorage', 61.2181, -149.9003, -32400], ['Los Angeles', 34.0522, -118.2437, -28800],
			['Mexico City', 19.4326, -99.1332, -21600], ['New York', 40.7128, -74.006, -18000],
			['Lima', -12.0464, -77.0428, -18000], ['Ushuaia', -54.8019, -68.303, -10800],
		];
		const steps = [];
		for (const [i, [city, lat, lon, offset]] of CITIES.entries()) {
			for (const [d, date] of ['2026-03-20', '2026-06-21', '2026-09-23', '2026-12-21'].entries()) {
				for (const hour of [0, 6, 12, 18]) {
					const time = Date.parse(`${date}T${String(hour).padStart(2, '0')}:${String(7 * i % 60).padStart(2, '0')}:00Z`);
					// Alternate a location-only start with a forecast that has no daily data:
					// both put the computed sunrise and sunset on the ruler.
					const payload = (d + hour / 6) % 2 === 0 ? `${lat},${lon}`
						: wire({lat, lon, updatedAt: time, weather: {current: {temperature_2m: 15 + i, weather_code: [0, 2, 61, 71][d]}, utc_offset_seconds: offset}});
					steps.push(['now', time], ['msg', null, payload], ['check', `${city} ${date} ${hour}:00Z`]);
				}
			}
		}
		const worst = check(scenario({w, h, start: Date.parse('2026-01-01T00:00:00Z'), sessions: [steps]}));
		process.stdout.write(`# ${name}: 20 cities, worst globe disc difference ${(worst * 100).toFixed(2)}%\n`);
	});

	test(`${name}: payload edge cases parse as the JavaScript face does`, {skip}, () => {
		const start = T('2026-09-09T18:00:00Z');
		const sec = SEC;
		const days = (offset, n) => ({
			time: Array.from({length: n}, (_, i) => sec + (i - 2) * 86400 - offset),
			sunrise: Array.from({length: n}, (_, i) => sec + (i - 2) * 86400 + 43200),
			sunset: Array.from({length: n}, (_, i) => sec + (i - 1) * 86400),
		});
		const payload = (current, extra = {}) => wire({lat: 30, lon: -97, updatedAt: start,
			weather: {current, utc_offset_seconds: -18000, daily: days(-18000, 3), ...extra}});
		check(scenario({w, h, start, sessions: [[
			['msg', null, payload({temperature_2m: 104.4, weather_code: 3})], ['check', 'three digits'],
			['msg', null, payload({temperature_2m: -12.5, weather_code: 71})], ['check', 'negative half rounds up'],
			['msg', null, payload({temperature_2m: null, weather_code: 1})], ['check', 'no temperature keeps the last weather'],
			['msg', null, payload({temperature_2m: 50, weather_code: 4})], ['check', 'unknown code'],
			['msg', null, payload({temperature_2m: 50, weather_code: 1.5})], ['check', 'fractional code'],
			['msg', null, '91,0,,50,0,0'], ['check', 'latitude out of range'],
			['msg', null, '{'], ['check', 'garbage'],
			['msg', null, ' 30 , -97 ,, 61 ,0, -18000'], ['check', 'padded numbers'],
			['msg', null, '3e1,-9.7e1,,6.1e1,0,-1.8e4'], ['check', 'exponents'],
			['msg', null, payload({temperature_2m: 70, weather_code: 0}, {daily: days(-18000, 6)})], ['check', 'six days, two before yesterday'],
			['msg', null, wire({lat: 1.87, lon: -157.4, updatedAt: start, weather: {current: {temperature_2m: 84, weather_code: 2},
				utc_offset_seconds: 50400, daily: days(50400, 3)}})], ['check', 'UTC+14'],
			['msg', null, wire({lat: 30, lon: -97, updatedAt: T('2026-09-09T15:30:00Z'), weather: {current: {temperature_2m: 77, weather_code: 0},
				utc_offset_seconds: -18000, daily: days(-18000, 3)}})], ['check', 'stale on arrival'],
		]]}));
	});
}

for (const [name, w, h, , [cx, cy, r], hudY] of [['Time 2', 200, 228, 0, [100, 66, 64], 132], ['Round 2', 260, 260, 0, [130, 78, 70], 150]]) {
	test(`${name}: the battery box stays off the globe`, () => {
		const [x0, y0, x1, y1] = BATTERY_BOX[w];
		for (let y = y0; y < y1; y++)
			for (let x = x0; x < x1; x++)
				assert.ok((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 > (r + 1) ** 2, `(${x},${y}) is on the globe`);
	});

	test(`${name}: the battery glyph, number and percent sign, by charge and theme`, {skip}, () => {
		const start = T('2026-09-09T18:00:00Z');
		const CASES = [
			// theme, percent, charging, fill width, ink, fill color
			[0, 100, false, 9, 0xEA, 0xEA],
			[0, 50, false, 5, 0xEA, 0xEA],
			[0, 21, false, 2, 0xEA, 0xEA],
			[0, 20, false, 2, 0xFF, 0xFF],
			[0, 5, false, 1, 0xFF, 0xFF],
			[0, 0, false, 0, 0xFF, 0xFF],
			[0, 12, true, 1, 0xEA, 0xCF],
			[0, 100, true, 9, 0xEA, 0xCF],
			[2, 64, false, 6, 0xD5, 0xD5],
			[2, 10, false, 1, 0xC0, 0xC0],
			[2, 64, true, 6, 0xD5, 0xC2],
			[3, 64, false, 6, 0xEA, 0xEA],
		];
		const steps = [['msg', null, forecast({updatedAt: start})]];
		for (const [theme, percent, charging] of CASES)
			steps.push(['msg', theme, null], ['battery', percent, charging], ['check']);
		const c = runC({w, h, now: start, hour12: false, persist: []}, steps);
		const sky = {0: 0xC0, 2: 0xFF, 3: 0xD5};
		// The percent sign, 5x7: one rectangle per run of set bits.
		const PERCENT = ['##..#', '##..#', '...#.', '..#..', '.#...', '#..##', '#..##'];
		const percentRects = PERCENT.reduce((n, row) => n + row.split(/\.+/).filter(Boolean).length, 0);
		const [right, top] = w === h ? [249, 102] : [191, 6];
		for (const [k, [theme, percent, charging, fillW, ink, level]] of CASES.entries()) {
			const label = `theme ${theme}, ${percent}%${charging ? ' charging' : ''}`;
			const {rects, texts} = c.frames[k];
			const hud = rects.findIndex(([, x, y, rw]) => x === 0 && y === hudY && rw === w);
			const n = 1 + 5 + (fillW ? 1 : 0) + percentRects;
			const battery = rects.slice(hud - n, hud);
			const [clear, ...rest] = battery;
			const glyph = rest.slice(0, 5 + (fillW ? 1 : 0));
			const sign = rest.slice(glyph.length);
			assert.equal(clear[0], sky[theme], `${label}: the stars are cleared in the sky's color`);
			for (const [, x, y, rw, rh] of battery)
				assert.ok(inBatteryBox(w, x, y) && inBatteryBox(w, x + rw - 1, y + rh - 1), `${label}: [${x},${y},${rw},${rh}] leaves the box`);
			assert.deepEqual(glyph.slice(0, 5).map(rect => rect[0]), [ink, ink, ink, ink, ink], `${label}: outline`);
			if (fillW) {
				assert.equal(glyph[5][0], level, `${label}: charge color`);
				assert.equal(glyph[5][3], fillW, `${label}: charge width`);
			}
			// Glyph, digits, then the sign, ending at the right edge.
			const parts = texts.filter(isBatteryText(w));
			assert.equal(parts.map(t => t[0]).join(''), `${percent}`, `${label}: the digits`);
			for (const [, size, color, , ty] of parts) {
				assert.equal(size, 14);
				assert.equal(color, ink, `${label}: digit color`);
				// Gothic 14 Bold digits sit 5 px under their box top: from top to top + 9.
				assert.equal(ty + 5, top, `${label}: digits' top`);
			}
			const signX = Math.min(...sign.map(r => r[1]));
			const signY = Math.min(...sign.map(r => r[2]));
			assert.ok(sign.every(r => r[0] === ink), `${label}: sign color`);
			assert.equal(Math.max(...sign.map(r => r[1] + r[3])), right, `${label}: the sign ends at the right edge`);
			assert.equal(signY + 7, top + 9, `${label}: the sign sits on the digits' baseline`);
			assert.ok(parts[0][3] > glyph[0][1] + 15 && signX > parts[parts.length - 1][3], `${label}: glyph, then digits, then the sign`);
			const [, gx, gy] = glyph[0];
			assert.equal(gy, top + 1, `${label}: the glyph is centered on the digits`);
			// On Round 2 everything stays 4 px inside the circle.
			if (w === h)
				for (const [x, y] of [[gx, gy], [gx, gy + 6], [right - 1, top], [right - 1, top + 8]])
					assert.ok((x + 0.5 - w / 2) ** 2 + (y + 0.5 - h / 2) ** 2 < (w / 2 - 4) ** 2, `${label}: (${x},${y}) is near the round edge`);
		}
	});

	test(`${name}: a battery event redraws the number, with or without a location`, {skip}, () => {
		const start = T('2026-09-09T18:00:00Z');
		const c = runC({w, h, now: start, hour12: false, persist: []},
			[['check'], ['battery', 42, false], ['check'], ['msg', null, forecast({updatedAt: start})], ['battery', 41, true], ['check']]);
		assert.deepEqual(c.frames.map(f => batteryNumber(w, f.texts)), ['80', '42', '41']);
	});
}

for (const [name, w, h] of [['Time 2', 200, 228], ['Round 2', 260, 260]]) {
	test(`${name}: a relaunch draws the stored land exactly as computed, and storage stays in budget`, {skip}, () => {
		const start = T('2026-09-09T18:00:00Z');
		const later = start + 2000;
		const data = forecast({lat: 31.7683, lon: 35.2137, offset: 7200, updatedAt: start});
		// First launch: the land is computed, then written a second after the frame.
		const first = runC({w, h, now: start, hour12: false, persist: []},
			[['msg', 0, data], ['check'], ['now', later], ['timers'], ['check']]);
		const land = first.persist.filter(([key]) => key >= 10);
		assert.ok(land.length >= 2, 'the land is stored');
		assert.ok(land.every(([, v]) => typeof v === 'object' && v.data.length / 2 <= 256), 'in data values of at most 256 bytes');
		assert.equal(first.writes, 1 + land.length, 'the payload and the land, once (theme 0 is the default)');
		// Pebble keeps 4 KB per app: the biggest payload and the land, with a
		// generous 16 bytes of overhead per key, fit.
		const used = first.persist.reduce((n, [, v]) => n + 16 + (typeof v === 'number' ? 4 : typeof v === 'object' ? v.data.length / 2 : v.length + 1), 0);
		assert.ok(used + 500 < 4096, `storage ${used} bytes`);

		// Relaunch at the same place: the same frame, and nothing written.
		const again = runC({w, h, now: later, hour12: false, persist: first.persist}, [['check'], ['now', later + 2000], ['timers']]);
		assert.deepEqual(again.frames[0], first.frames[1], 'the frame drawn from storage is the computed one');
		assert.equal(again.writes, 0, 'the stored land is read, not rewritten');

		// Damaged or mismatched storage is computed afresh: the same frame, stored again.
		const flip = hex => (parseInt(hex[0], 16) ^ 1).toString(16) + hex.slice(1);
		const damaged = [
			['a flipped land bit', first.persist.map(([k, v]) => [k, k === 11 ? {data: flip(v.data)} : v])],
			['a missing land key', first.persist.filter(([k]) => k !== 12)],
			['a damaged header', first.persist.map(([k, v]) => [k, k === 10 ? {data: flip(v.data)} : v])],
			['a short header', first.persist.map(([k, v]) => [k, k === 10 ? {data: v.data.slice(0, -2)} : v])],
		];
		for (const [label, persist] of damaged) {
			const run = runC({w, h, now: later, hour12: false, persist}, [['check'], ['now', later + 2000], ['timers']]);
			assert.deepEqual(run.frames[0], first.frames[1], `${label}: the same frame`);
			assert.equal(run.writes, land.length, `${label}: the land is stored again`);
		}

		// Another place is not drawn from the stored land.
		const moved = forecast({lat: 31.7683, lon: 35.2138, offset: 7200, updatedAt: start});
		const fresh = runC({w, h, now: later, hour12: false, persist: []}, [['msg', 0, moved], ['check']]);
		const elsewhere = runC({w, h, now: later, hour12: false, persist: first.persist}, [['msg', 0, moved], ['check'], ['now', later + 2000], ['timers']]);
		assert.deepEqual(elsewhere.frames[0], fresh.frames[0], 'a new place is computed');
		assert.equal(elsewhere.writes, 1 + land.length, 'and its land stored');
	});
}

test('the hourly refresh asks the phone once an hour, only when it is connected', {skip}, () => {
	const lines = connected => [`size 200 228`, `now ${Date.parse('2026-09-09T17:58:00Z') / 1000}`, `connected ${connected}`, 'start',
		`now ${Date.parse('2026-09-09T17:59:00Z') / 1000}`, 'tick', `now ${Date.parse('2026-09-09T18:00:00Z') / 1000}`, 'tick',
		`now ${Date.parse('2026-09-09T18:01:00Z') / 1000}`, 'tick', 'sent', 'persist'].join('\n') + '\n';
	for (const [connected, sent] of [[1, 1], [0, 0]]) {
		const run = spawnSync(BIN, [], {input: lines(connected), encoding: 'utf8'});
		assert.equal(JSON.parse(run.stdout.split('\n')[0]).sent, sent);
	}
});

test('the payload and theme are stored once and survive a relaunch', {skip}, () => {
	const start = Date.parse('2026-09-09T18:00:00Z');
	const data = forecast({updatedAt: start});
	const c = runC({w: 200, h: 228, now: start, hour12: false, persist: []},
		[['msg', 3, data], ['msg', 3, data], ['msg', null, 'E'], ['msg', 9, null]]);
	assert.deepEqual(c.persist, [[1, 3], [2, data]]);
	assert.equal(c.writes, 2, 'repeats, errors and unknown themes do not rewrite flash');
	const again = runC({w: 200, h: 228, now: start, hour12: false, persist: c.persist}, [['check']]);
	assert.ok(again.frames[0].texts.some(t => t[0] === 'RISE 0'), 'the stored forecast draws at launch');
	assert.ok(again.frames[0].rects.some(r => r[0] === 0xD5 && r[2] === 132), 'in the stored theme');
	assert.equal(again.writes, 0, 'a relaunch reads storage without writing it');
});

test('the baked Round 2 star table is what the lattice generator lays out', () => {
	const {roundStars, cArray} = require('../scripts/gen-round-stars.cjs');
	const stars = roundStars();
	assert.equal(stars.placed, stars.n);
	const src = fs.readFileSync(path.join(ROOT, 'src/c/yearstars.c'), 'utf8');
	assert.deepEqual(Array.from(cArray(src, 'ROUND_STAR_X')), Array.from(stars.x));
	assert.deepEqual(Array.from(cArray(src, 'ROUND_STAR_Y')), Array.from(stars.y));
	const layout = fs.readFileSync(path.join(ROOT, 'src/c/yearlight.c'), 'utf8').match(/LAYOUT_ROUND = \{(\d+), (\d+), (\d+), (\d+),/).slice(1).map(Number);
	const {ROUND_LAYOUT: r} = require('../scripts/gen-round-stars.cjs');
	assert.deepEqual(layout, [r.mapW, r.mapH, r.globeCY, r.globeR]);
});

test('the C stars are the JavaScript face\'s, and the finer mask agrees with its coarse one', () => {
	const src = name => fs.readFileSync(path.join(ROOT, 'src/c', name), 'utf8');
	const {cArray} = require('../scripts/gen-round-stars.cjs');
	const ctx = vm.createContext({});
	for (const file of ['worldmask', 'yearstars'])
		vm.runInContext(fs.readFileSync(path.join(__dirname, `reference/${file}.js`), 'utf8').replace(/^export /gm, ''), ctx);
	for (const name of ['STAR_X', 'STAR_Y', 'STAR_SHAPE'])
		assert.deepEqual(Array.from(cArray(src('yearstars.c'), name)), Array.from(vm.runInContext(name, ctx)), name);
	// 1:50m at 400x200 against 1:110m at 200x100: each coarse cell is land when
	// at least two of its four fine cells are. They differ only along coasts.
	assert.equal(MASK.length, MASK_W * MASK_H / 8);
	const old = vm.runInContext('MASK', ctx);
	const [ow, oh] = [vm.runInContext('MASK_W', ctx), vm.runInContext('MASK_H', ctx)];
	const fx = MASK_W / ow, fy = MASK_H / oh;
	const bit = (m, i) => (m[i >> 3] >> (i & 7)) & 1;
	let same = 0;
	for (let y = 0; y < oh; y++)
		for (let x = 0; x < ow; x++) {
			let n = 0;
			for (let j = 0; j < fy; j++)
				for (let i = 0; i < fx; i++)
					n += bit(MASK, (y * fy + j) * MASK_W + x * fx + i);
			if ((2 * n >= fx * fy ? 1 : 0) === bit(old, y * ow + x)) same++;
		}
	const agree = same / (ow * oh);
	process.stdout.write(`# the 1:50m mask agrees with 1:110m on ${(agree * 100).toFixed(1)}% of coarse cells\n`);
	assert.ok(agree > 0.95, `agreement ${agree}`);
});

test('the moon marker sits on the sub-lunar point, within a pixel of astropy', {skip}, () => {
	const {points} = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/moon.json'), 'utf8'));
	for (const [w, h, cx, cy, r] of [[200, 228, 100, 66, 64], [260, 260, 130, 78, 70]]) {
		// Seen from Jerusalem; the view tilt is the place's latitude (under the 40° clamp).
		const [lat, lon] = [31.7683, 35.2137];
		const lines = [`size ${w} ${h}`, `now ${points[0].t}`, 'start', `msg - ${lat},${lon}`];
		for (const p of points)
			lines.push(`now ${p.t}`, 'tick', 'frame');
		const run = spawnSync(MOON_BIN, [], {input: lines.join('\n') + '\n', encoding: 'utf8', maxBuffer: 1 << 28});
		const frames = run.stdout.trim().split('\n').map(line => JSON.parse(line));
		const rad = Math.PI / 180;
		let seen = 0;
		points.forEach((p, i) => {
			const dlon = (p.lon - lon) * rad;
			const near = Math.sin(lat * rad) * Math.sin(p.lat * rad) + Math.cos(lat * rad) * Math.cos(p.lat * rad) * Math.cos(dlon);
			const body = frames[i].rects.filter(([c, , y, rw, rh]) => c === 0xEA && rw === 5 && rh === 3 && y < cy + r);
			if (Math.abs(near) < 0.05)
				return;  // on the limb: either side of it is fine
			if (near < 0) {
				assert.equal(body.length, 0, `${p.t}: a moon behind the globe is drawn`);
				return;
			}
			const x = cx + r * Math.cos(p.lat * rad) * Math.sin(dlon);
			const y = cy - r * (Math.cos(lat * rad) * Math.sin(p.lat * rad) - Math.sin(lat * rad) * Math.cos(p.lat * rad) * Math.cos(dlon));
			assert.equal(body.length, 1, `${p.t}: moon marker missing`);
			const [, bx, by] = body[0];
			assert.ok(Math.abs(bx + 2 - x) <= 1.5 && Math.abs(by + 1 - y) <= 1.5, `${p.t}: moon at ${bx + 2},${by + 1}, astropy ${x.toFixed(1)},${y.toFixed(1)}`);
			seen++;
		});
		assert.ok(seen >= 15, `only ${seen} visible moons checked`);
	}
});
