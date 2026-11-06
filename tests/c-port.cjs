// Holds the native C watchface to the JavaScript face it replaces
// (tests/reference/*.js, Yearlight 1.2.0). Both run the same scripts of time,
// phone messages, timers and quick views; their final frames must match:
// every pixel outside the globe disc and every text draw exactly, and the
// disc to within the C build's fixed-point land and terminator rounding.
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

const built = spawnSync('gcc', ['-std=c99', '-Wall', '-Wextra', '-Werror', '-Wno-unused-parameter', '-Os',
	'-I', path.join(__dirname, 'c'), ...fs.readdirSync(path.join(ROOT, 'src/c')).filter(f => f.endsWith('.c')).map(f => path.join(ROOT, 'src/c', f)),
	path.join(__dirname, 'c/mock.c'), '-lm', '-o', BIN], {encoding: 'utf8'});
const skip = built.error ? 'gcc not available' : false;
if (!skip && built.status !== 0)
	throw new Error('host build failed:\n' + built.stderr);
process.on('exit', () => fs.rmSync(BIN, {force: true}));

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
		lines.push(typeof value === 'number' ? `persist_int ${key} ${value}` : `persist_str ${key} ${value}`);
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
					c: {fb: raster(w, h, got.rects), texts: got.texts}, globe: js.eval('[GLOBE_CX, GLOBE_CY, GLOBE_R]')});
			}
		}
		persist = c.persist;
	}
	return results;
}

function compare(result) {
	const {w, h, js, c, globe: [cx, cy, r]} = result;
	let disc = 0, discDiff = 0, outsideDiff = 0;
	let firstOutside = null;
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const i = y * w + x;
			const inDisc = (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= (r + 1) ** 2;
			if (inDisc) disc++;
			if (js.fb[i] === c.fb[i]) continue;
			if (inDisc) discDiff++;
			else {
				outsideDiff++;
				firstOutside ??= `(${x},${y}) js ${js.fb[i]} c ${c.fb[i]}`;
			}
		}
	}
	return {disc, discDiff, outsideDiff, firstOutside};
}

function check(results) {
	let worst = 0;
	for (const result of results) {
		assert.deepEqual(result.c.texts, result.js.texts, `${result.label}: texts`);
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

test('the C tables hold the JavaScript face\'s mask and stars', () => {
	const src = name => fs.readFileSync(path.join(ROOT, 'src/c', name), 'utf8');
	const {cArray} = require('../scripts/gen-round-stars.cjs');
	const ctx = vm.createContext({});
	for (const file of ['worldmask', 'yearstars'])
		vm.runInContext(fs.readFileSync(path.join(__dirname, `reference/${file}.js`), 'utf8').replace(/^export /gm, ''), ctx);
	const body = src('worldmask.c').match(/WORLD_MASK\[[^\]]*\] = \{([^}]*)\}/)[1];
	const mask = Uint8Array.from(body.match(/0x[0-9a-f]{2}/g).map(v => parseInt(v, 16)));
	assert.deepEqual(Array.from(mask), Array.from(vm.runInContext('MASK', ctx)));
	for (const name of ['STAR_X', 'STAR_Y', 'STAR_SHAPE'])
		assert.deepEqual(Array.from(cArray(src('yearstars.c'), name)), Array.from(vm.runInContext(name, ctx)), name);
});
