const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const wire = require('./wire.cjs');

// Boots the watch code with a Poco that records rectangles, optional storage,
// and timers that run only when asked (and only those due now: the 2 s default
// globe and 30 s offline timers never fire).
function boot({width = 200, height = 228, store = null} = {}) {
	const now = Date.UTC(2026, 8, 9, 18);
	const rects = [];
	const timers = [];
	class Clock extends Date {
		constructor(...args) { super(...(args.length ? args : [now])); }
		static now() { return now; }
	}
	class Poco {
		constructor() {
			this.Font = class { constructor(name, size) { this.name = name; this.size = size; } };
			this.width = width;
			this.height = height;
			this.unobstructed = {width, height};
		}
		makeColor(r, g, b) { return (r << 16) | (g << 8) | b; }
		begin() {}
		end() {}
		fillRectangle(color, x, y, w, h) { rects.push([color, x, y, w, h]); }
		drawText() {}
		getTextWidth(text, font) { return String(text).length * Math.ceil(font.size * 0.5); }
	}
	class Message { constructor() {} }
	const context = vm.createContext({
		Poco, Message, screen: {}, Date: Clock, console: {log() {}},
		watch: {hour12: false, addEventListener() {}},
		setTimeout(fn, delay) { if (!delay) timers.push(fn); }, clearTimeout() {},
	});
	if (store) {
		store.counts = store.counts || {};
		context.localStorage = {
			getItem(k) { return store.has(k) ? store.get(k) : null; },
			setItem(k, v) { store.set(k, String(v)); store.counts[k] = (store.counts[k] || 0) + 1; },
		};
	}
	for (const file of ['worldmask', 'yearstars', 'main']) {
		const source = fs.readFileSync(path.join(__dirname, `../src/embeddedjs/${file}.js`), 'utf8')
			.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
		vm.runInContext(source, context);
	}
	const evaluate = code => vm.runInContext(code, context);
	evaluate('var landComputes = 0; computeLand = (f => function (...args) { landComputes++; return f(...args); })(computeLand);');
	return {
		rects, eval: evaluate,
		runTimers() { while (timers.length) timers.shift()(); },
		deliver(data) { context.payload = wire(data); evaluate('applyPayload(payload)'); },
		globe(time, origin) {
			rects.length = 0;
			evaluate(`drawMap(sunAt(new Date(${time})), ${JSON.stringify(origin)})`);
			return rects.slice();
		},
	};
}

// The globe as the per-sample renderer before the run-based rewrite drew it
// (land cache, isLand and drawMap copied from it), reading the land mask
// through the original byte decode, so both the drawing and the mask
// re-encoding are held to the old output.
function reference(h) {
	const [X0, X1, Y0, Y1, CX, CY, R, MAP_W, MAP_H, NIGHT_SIN, MASK_W, MASK_H] = h.eval(
		'[GLOBE_X0, GLOBE_X1, GLOBE_Y0, GLOBE_Y1, GLOBE_CX, GLOBE_CY, GLOBE_R, MAP_W, MAP_H, NIGHT_SIN, MASK_W, MASK_H]');
	const colors = h.eval('GLOBE_COLORS');
	const HEX = h.eval('PARTS.join("")');
	const MASK = new Uint8Array(HEX.length >> 1);
	for (let i = 0; i < MASK.length; i++) {
		const hi = HEX.charCodeAt(i << 1);
		const lo = HEX.charCodeAt((i << 1) + 1);
		MASK[i] = ((hi < 58 ? hi - 48 : hi - 87) << 4) | (lo < 58 ? lo - 48 : lo - 87);
	}
	function isLand(lon, lat) {
		let x = ((lon + 180) / 360 * MASK_W) | 0;
		let y = ((90 - lat) / 180 * MASK_H) | 0;
		x = ((x % MASK_W) + MASK_W) % MASK_W;
		if (y < 0) y = 0;
		else if (y >= MASK_H) y = MASK_H - 1;
		const i = y * MASK_W + x;
		return (MASK[i >> 3] >> (i & 7)) & 1;
	}
	const SAMPLE_W = (X1 - X0) >> 1;
	return function draw(sun, origin, sky) {
		const lon0 = origin.lon * Math.PI / 180;
		const lat0 = origin.lat * Math.PI / 180;
		const sinLat0 = Math.sin(lat0);
		const cosLat0 = Math.cos(lat0);
		const sinLon0 = Math.sin(lon0);
		const cosLon0 = Math.cos(lon0);
		const landBits = new Uint8Array((SAMPLE_W * ((Y1 - Y0) >> 1) + 7) >> 3);
		for (let y = Y0; y < Y1; y += 2) {
			const yn = (CY - (y + 1)) / R;
			for (let x = X0; x < X1; x += 2) {
				const xn = (x + 1 - CX) / R;
				const rr = xn * xn + yn * yn;
				if (rr > 1) continue;
				const z = Math.sqrt(1 - rr);
				const lat = Math.asin(Math.max(-1, Math.min(1, yn * cosLat0 + z * sinLat0))) * 180 / Math.PI;
				let lon = (lon0 + Math.atan2(xn, z * cosLat0 - yn * sinLat0)) * 180 / Math.PI;
				lon = ((lon + 180) % 360 + 360) % 360 - 180;
				if (isLand(lon, lat)) {
					const i = ((y - Y0) >> 1) * SAMPLE_W + ((x - X0) >> 1);
					landBits[i >> 3] |= 1 << (i & 7);
				}
			}
		}
		const sunX = -sun.cosY * sun.cosX;
		const sunY = -sun.cosY * sun.sinX;
		const sunZ = -sun.sinY;
		const a = sunX * cosLon0 + sunY * sinLon0;
		const vx = sunY * cosLon0 - sunX * sinLon0;
		const vy = sunZ * cosLat0 - a * sinLat0;
		const vz = a * cosLat0 + sunZ * sinLat0;
		const out = [[sky, 0, 0, MAP_W, MAP_H]];
		for (let y = Y0; y < Y1; y += 2) {
			let runX = 0;
			let runColor = -1;
			const yn = (CY - (y + 1)) / R;
			const row = ((y - Y0) >> 1) * SAMPLE_W;
			for (let x = X0; x <= X1; x += 2) {
				let color = -1;
				if (x < X1) {
					const xn = (x + 1 - CX) / R;
					const rr = xn * xn + yn * yn;
					if (rr <= 1) {
						const i = row + ((x - X0) >> 1);
						const land = (landBits[i >> 3] >> (i & 7)) & 1;
						const night = vx * xn + vy * yn + vz * Math.sqrt(1 - rr) < NIGHT_SIN;
						color = (land ? 2 : 0) + (night ? 1 : 0);
					}
				}
				if (color === runColor) continue;
				if (runColor >= 0) out.push([colors[runColor], runX, y, x - runX, 2]);
				runX = x;
				runColor = color;
			}
		}
		return out;
	};
}

// Deterministic spread of view origins (inside the ±40° tilt clamp) and times.
function* cases(count) {
	let seed = 12345;
	const rand = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296;
	const fixed = [
		{lon: -97, lat: 30}, {lon: -90, lat: 15}, {lon: 0, lat: 0}, {lon: 180, lat: 40},
		{lon: -180, lat: -40}, {lon: 139.69, lat: 35.69}, {lon: -0.13, lat: 40}, {lon: 151.2, lat: -33.87},
	];
	const days = [Date.UTC(2026, 2, 20), Date.UTC(2026, 5, 21), Date.UTC(2026, 8, 23), Date.UTC(2026, 11, 21)];
	for (const origin of fixed)
		for (const day of days)
			for (let hour = 0; hour < 24; hour += 3)
				yield {origin, time: day + hour * 3600000 + 7 * 60000};
	for (let i = 0; i < count; i++) {
		const origin = {lon: Math.round((rand() * 360 - 180) * 1e4) / 1e4, lat: Math.round((rand() * 80 - 40) * 1e4) / 1e4};
		yield {origin, time: Date.UTC(2026, 0, 1) + Math.floor(rand() * 2 * 365 * 86400000)};
	}
}

for (const [name, width, height] of [['Time 2', 200, 228], ['Round 2', 260, 260]]) {
	test(`${name}: the run-based globe paints exactly the old per-sample rectangles`, () => {
		const h = boot({width, height});
		const draw = reference(h);
		const sky = h.eval('theme.sky');
		let compared = 0;
		for (const {origin, time} of cases(250)) {
			const got = h.globe(time, origin);
			const want = draw(h.eval(`sunAt(new Date(${time}))`), origin, sky);
			assert.deepEqual(got, want, `origin ${origin.lon},${origin.lat} at ${new Date(time).toISOString()}`);
			compared++;
		}
		assert.ok(compared > 400);
	});
}

test('the land rows are stored once and a relaunch draws without the inverse projection', () => {
	const store = new Map();
	const h = boot({store});
	const sec = Date.UTC(2026, 8, 9) / 1000;
	const data = {lat: 30, lon: -97, weather: {current: {temperature_2m: 82, weather_code: 0}, utc_offset_seconds: -18000,
		daily: {time: [sec + 18000], sunrise: [sec + 43200], sunset: [sec + 86400]}}};
	h.deliver(data);
	assert.equal(h.eval('landComputes'), 1, 'a new place projects its land');
	assert.equal(store.counts.ld, undefined, 'the write waits until the frame is out');
	h.runTimers();
	assert.equal(store.counts.ld, 1);
	assert.match(store.get('ld'), /^1,200,-97,30,/);
	const first = h.rects.slice();

	const again = boot({store});
	again.deliver(data);
	again.runTimers();
	assert.equal(again.eval('landComputes'), 0, 'stored land skips the asin/atan2 projection');
	assert.equal(store.counts.ld, 1, 'a restore does not rewrite flash');
	assert.deepEqual(again.rects.filter(r => r[2] + r[4] <= 132), first.filter(r => r[2] + r[4] <= 132));

	// Same globe on the next half hour from memory: no projection, no write.
	again.eval('globeDrawn.step = -1; drawScreen()');
	again.runTimers();
	assert.equal(again.eval('landComputes'), 0);
	assert.equal(store.counts.ld, 1);
});

test('stored land for another place, layout or a damaged entry is recomputed', () => {
	const t = Date.UTC(2026, 8, 9, 18);
	const fresh = boot().globe(t, {lon: 10, lat: 20});
	for (const stored of [
		'1,200,-97,30,' + '/'.repeat(64),     // another place
		'1,260,10,20,' + '/'.repeat(64),      // the round layout
		'1,200,10,20,' + '/'.repeat(63),      // a row short
		'1,200,10,20,' + 'z/'.repeat(64),     // a flip outside the disc
		'1,200,10,20,' + '/'.repeat(64) + '0', // trailing bytes
		'0,200,10,20,' + '/'.repeat(64),      // an older format
	]) {
		const store = new Map([['ld', stored]]);
		const h = boot({store});
		assert.deepEqual(h.globe(t, {lon: 10, lat: 20}), fresh, stored.slice(0, 16));
		assert.equal(h.eval('landComputes'), 1, stored.slice(0, 16));
		h.runTimers();
		assert.equal(store.counts.ld, 1);
		assert.match(store.get('ld'), /^1,200,10,20,/);
	}
});

test('a stored land entry round-trips through restore', () => {
	const store = new Map();
	const h = boot({store});
	const t = Date.UTC(2026, 2, 20, 6);
	const want = h.globe(t, {lon: 139.69, lat: 35.69});
	h.runTimers();
	const again = boot({store});
	assert.deepEqual(again.globe(t, {lon: 139.69, lat: 35.69}), want);
	assert.equal(again.eval('landComputes'), 0);
});

test('the baked Round 2 star table is what the lattice generator lays out', () => {
	const {roundStars, ROUND_LAYOUT} = require('../scripts/gen-round-stars.cjs');
	const h = boot({width: 260, height: 260});
	const [mapW, mapH, globeCX, globeCY, globeR] = h.eval('[MAP_W, MAP_H, GLOBE_CX, GLOBE_CY, GLOBE_R]');
	assert.deepEqual({mapW, mapH, globeCX, globeCY, globeR}, ROUND_LAYOUT, 'generator layout matches main.js');
	const stars = roundStars();
	assert.equal(stars.placed, stars.n);
	assert.deepEqual(Array.from(h.eval('STAR_X')), Array.from(stars.x));
	assert.deepEqual(Array.from(h.eval('STAR_Y')), Array.from(stars.y));
});

test('year stars draw the lit days and the four season stars, in index order', () => {
	const h = boot();
	for (const iso of ['2026-01-01T12:00:00', '2026-03-20T12:00:00', '2026-09-09T12:00:00', '2026-12-31T12:00:00', '2028-06-01T12:00:00']) {
		h.rects.length = 0;
		h.eval(`drawYearStars(new Date("${iso}"))`);
		const got = h.rects.slice();
		// The old loop: every star up to today, plus isSeasonStar ones after it.
		h.rects.length = 0;
		h.eval(`(() => {
			const now = new Date("${iso}");
			const n = litStarCount(now);
			for (let i = 0; i < STAR_N; i++) {
				const season = isSeasonStar(i, now.getFullYear());
				if (i >= n && !season) continue;
				const color = season ? theme.season : theme.star;
				const x = STAR_X[i], y = STAR_Y[i], shape = STAR_SHAPE[i];
				if (shape === 0) render.fillRectangle(color, x, y, 1, 1);
				else if (shape === 1) render.fillRectangle(color, x, y, 2, 1);
				else if (shape === 2) { render.fillRectangle(color, x - 1, y, 3, 1); render.fillRectangle(color, x, y - 1, 1, 3); }
				else render.fillRectangle(color, x - 1, y - 1, 3, 3);
			}
		})()`);
		assert.deepEqual(got, h.rects, iso);
	}
});
