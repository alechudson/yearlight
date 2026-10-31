const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const wire = require('./wire.cjs');

// Pebble Round 2 (gabbro): 260x260, everything drawn must sit inside the circle.
function boot() {
	const now = Date.UTC(2026, 8, 9, 18);
	const calls = [];
	class Clock extends Date {
		constructor(...args) { super(...(args.length ? args : [now])); }
		static now() { return now; }
	}
	class Poco {
		constructor() {
			this.Font = class { constructor(name, size) { this.name = name; this.size = size; } };
			this.width = 260;
			this.height = 260;
			this.unobstructed = {width: 260, height: 260};
		}
		makeColor(r, g, b) { return (r << 16) | (g << 8) | b; }
		begin() { calls.length = 0; }
		end() {}
		fillRectangle(color, x, y, width, height) { calls.push({kind: 'rect', color, x, y, width, height}); }
		drawText(text, font, color, x, y) { calls.push({kind: 'text', text, font, x, y, width: this.getTextWidth(text, font)}); }
		getTextWidth(text, font) { return String(text).length * Math.ceil(font.size * 0.5); }
	}
	class Message { constructor() {} }
	const context = vm.createContext({
		Poco, Message, screen: {}, Date: Clock, console: {log() {}},
		watch: {hour12: true, addEventListener() {}},
		setTimeout() {}, clearTimeout() {},
	});
	for (const file of ['worldmask', 'yearstars', 'main']) {
		const source = fs.readFileSync(path.join(__dirname, `../src/embeddedjs/${file}.js`), 'utf8')
			.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
		vm.runInContext(source, context);
	}
	const evaluate = code => vm.runInContext(code, context);
	return {calls, eval: evaluate, deliver(data) { context.payload = wire(data); evaluate('applyPayload(payload)'); }};
}

function inCircle(x, y) {
	return Math.hypot(x + 0.5 - 130, y + 0.5 - 130) <= 130;
}

test('round screens get the round layout', () => {
	const h = boot();
	assert.equal(h.eval('ROUND'), true);
	assert.equal(h.eval('MAP_W'), 260);
	assert.equal(h.eval('GLOBE_CX'), 130);
});

test('every year star lands in the round sky, off the globe', () => {
	const h = boot();
	const stars = h.eval('Array.from(STAR_X).map((x, i) => [x, STAR_Y[i]])');
	const [cx, cy, r, sky] = h.eval('[GLOBE_CX, GLOBE_CY, GLOBE_R, MAP_H]');
	assert.equal(stars.length, 365);
	for (const [x, y] of stars) {
		// Shapes reach one pixel out from the anchor.
		assert.ok(inCircle(x - 1, y - 1) && inCircle(x + 1, y + 1) && inCircle(x - 1, y + 1) && inCircle(x + 1, y - 1), `${x},${y} off screen`);
		assert.ok(y + 1 < sky, `${x},${y} in the HUD`);
		assert.ok(Math.hypot(x + 0.5 - cx, y + 0.5 - cy) > r + 2, `${x},${y} on the globe`);
	}
});

function openSky(x, y, cx, cy, r, sky) {
	if (y + 1 >= sky)
		return false;
	const screen = 130;
	const limit = (screen - 2) * (screen - 2);
	for (let k = 0; k < 4; k++) {
		const px = x + (k & 1 ? 1 : -1);
		const py = y + (k & 2 ? 1 : -1);
		const dx = px + 0.5 - screen;
		const dy = py + 0.5 - screen;
		if (dx * dx + dy * dy > limit)
			return false;
	}
	const gx = x + 0.5 - cx;
	const gy = y + 0.5 - cy;
	return gx * gx + gy * gy > (r + 4) * (r + 4);
}

test('round stars spread across the visible sky and stay put', () => {
	const h = boot();
	const again = boot();
	const stars = h.eval('Array.from(STAR_X).map((x, i) => [x, STAR_Y[i]])');
	const repeat = again.eval('Array.from(STAR_X).map((x, i) => [x, STAR_Y[i]])');
	let mismatch = -1;
	for (let i = 0; i < stars.length; i++) {
		if (stars[i][0] !== repeat[i][0] || stars[i][1] !== repeat[i][1]) {
			mismatch = i;
			break;
		}
	}
	assert.equal(mismatch, -1, mismatch < 0 ? '' : `${mismatch} ${stars[mismatch]} vs ${repeat[mismatch]}`);
	let nearest = Infinity;
	for (let i = 0; i < stars.length; i++) {
		for (let j = i + 1; j < stars.length; j++) {
			const d = Math.hypot(stars[i][0] - stars[j][0], stars[i][1] - stars[j][1]);
			if (d < nearest)
				nearest = d;
		}
	}
	assert.ok(nearest >= 4, `nearest stars are ${nearest}px apart`);
	const [cx, cy, r, sky] = h.eval('[GLOBE_CX, GLOBE_CY, GLOBE_R, MAP_H]');
	let farthest = 0;
	for (let y = 3; y < sky - 2; y += 8) {
		for (let x = 3; x < 256; x += 8) {
			if (!openSky(x, y, cx, cy, r, sky))
				continue;
			let near = Infinity;
			for (let i = 0; i < stars.length; i++) {
				const d = Math.hypot(x - stars[i][0], y - stars[i][1]);
				if (d < near)
					near = d;
			}
			if (near > farthest)
				farthest = near;
		}
	}
	assert.ok(farthest <= 12, `a patch of sky is ${farthest}px from the nearest star`);
});

test('HUD text stays inside the circle', () => {
	const h = boot();
	const sec = Date.UTC(2026, 8, 9) / 1000;
	h.deliver({lat: 30, lon: -97, weather: {current: {temperature_2m: 100, weather_code: 0},
		utc_offset_seconds: -18000,
		daily: {time: [sec + 18000, sec + 104400],
			temperature_2m_max: [89, 90], temperature_2m_min: [72, 73],
			sunrise: [sec + 43200, sec + 129600], sunset: [sec + 86400, sec + 172800]}}});
	const texts = h.calls.filter(c => c.kind === 'text');
	assert.ok(texts.some(t => t.text.startsWith('RISE')));
	for (const t of texts) {
		// Glyph ink sits within about 80% of the font size below the text origin.
		const bottom = t.y + Math.round(t.font.size * 0.8);
		assert.ok(inCircle(t.x, bottom) && inCircle(t.x + t.width, bottom), `${t.text} clipped`);
	}
});

test('a quick view lifts the clock above the obstruction', () => {
	const h = boot();
	h.eval('render.unobstructed = {width: 260, height: 157}');
	h.eval('globeDrawn.step = -1; invalidateHud(); drawScreen()');
	const clock = h.calls.find(c => c.kind === 'text' && /:/.test(c.text) && c.font.size === 42);
	assert.ok(clock.y + 42 <= 157, `clock at ${clock.y}`);
	h.eval('render.unobstructed = {width: 260, height: 260}');
	h.eval('globeDrawn.step = -1; invalidateHud(); drawScreen()');
	assert.equal(h.calls.find(c => c.kind === 'text' && c.font.size === 42).y, h.eval('MAP_H'));
});
