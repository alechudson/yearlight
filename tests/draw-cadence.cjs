const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const wire = require('./wire.cjs');

function boot() {
	let now = Date.UTC(2026, 8, 9, 18);
	const calls = [];
	const begins = [];
	const events = {};
	class Clock extends Date {
		constructor(...args) { super(...(args.length ? args : [now])); }
		static now() { return now; }
	}
	class Poco {
		constructor() {
			this.Font = class { constructor(name, size) { this.name = name; this.size = size; } };
			this.unobstructed = {width: 200, height: 228};
		}
		makeColor(r, g, b) { return (r << 16) | (g << 8) | b; }
		begin(...args) {
			begins.length = 0;
			begins.push(args);
			calls.length = 0;
		}
		end() {}
		fillRectangle(color, x, y, width, height) { calls.push({kind: 'rect', color, x, y, width, height}); }
		drawText(text, font, color, x, y) { calls.push({kind: 'text', text, font, color, x, y, width: this.getTextWidth(text, font)}); }
		getTextWidth(text, font) { return String(text).length * Math.ceil(font.size * 0.5); }
	}
	class Message { constructor() {} }
	const context = vm.createContext({
		Poco, Message, screen: {}, Date: Clock, console: {log() {}},
		watch: {hour12: false, addEventListener(name, fn) { events[name] = fn; }},
		setTimeout() {}, clearTimeout() {},
	});
	for (const file of ['worldmask', 'yearstars', 'main']) {
		const source = fs.readFileSync(path.join(__dirname, `../src/embeddedjs/${file}.js`), 'utf8')
			.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
		vm.runInContext(source, context);
	}
	const evaluate = code => vm.runInContext(code, context);
	return {
		calls, begins, events, eval: evaluate,
		deliver(data) { context.payload = wire(data); evaluate('applyPayload(payload)'); },
		tick(iso) { now = Date.parse(iso); events.minutechange({date: new Clock()}); },
		texts() { return calls.filter(c => c.kind === 'text').map(c => c.text); },
		globeRects() { return calls.filter(c => c.kind === 'rect' && c.y + c.height <= 132); },
	};
}

function forecast() {
	const sec = Date.UTC(2026, 8, 9) / 1000;
	return {lat: 30, lon: -97, weather: {current: {temperature_2m: 82, weather_code: 0},
		utc_offset_seconds: -18000,
		daily: {time: [sec + 18000, sec + 104400],
			temperature_2m_max: [89, 90], temperature_2m_min: [72, 73],
			sunrise: [sec + 43200, sec + 129600], sunset: [sec + 86400, sec + 172800]}}};
}

test('boot paints the clock without shading the globe', () => {
	const h = boot();
	assert.equal(h.globeRects().length, 1);
	assert.match(h.texts().join(' '), /:/);
	h.deliver(forecast());
	assert.ok(h.globeRects().length > 10);
});

test('minute ticks keep the clock moving without redrawing the globe', () => {
	const h = boot();
	h.deliver(forecast());
	assert.equal(h.begins[0].length, 0);
	assert.ok(h.globeRects().length > 0);
	assert.match(h.texts().join(' '), /:00/);
	h.tick('2026-09-09T18:01:00Z');
	assert.deepEqual(h.begins[0], [0, 132, 200, 42], 'only the clock strip when the caption and ruler hold');
	assert.equal(h.globeRects().length, 0);
	assert.equal(h.texts().length, 1, 'just the clock');
	h.tick('2026-09-09T18:29:00Z');
	assert.equal(h.globeRects().length, 0);
	assert.match(h.texts().join(' '), /:29/);
});

test('the globe redraws every half hour', () => {
	const h = boot();
	h.deliver(forecast());
	h.tick('2026-09-09T18:30:00Z');
	assert.equal(h.begins[0].length, 0);
	assert.ok(h.globeRects().length > 0);
	assert.match(h.texts().join(' '), /:00/);
});

test('a new location redraws the globe on the same minute', () => {
	const h = boot();
	h.deliver(forecast());
	h.tick('2026-09-09T18:01:00Z');
	assert.equal(h.globeRects().length, 0);
	const next = forecast();
	next.lat = 40;
	next.lon = -74;
	h.deliver(next);
	assert.equal(h.begins[0].length, 0);
	assert.ok(h.globeRects().length > 0);
});

test('default globe survives the next minute until location arrives', () => {
	const h = boot();
	h.eval('defaultGlobe = true');
	h.eval('drawScreen()');
	assert.ok(h.globeRects().length > 10);
	h.tick('2026-09-09T18:01:00Z');
	assert.deepEqual(h.begins[0], [0, 132, 200, 42]);
	assert.equal(h.globeRects().length, 0);
});

test('the whole HUD redraws when the sun marker moves or the caption changes', () => {
	const h = boot();
	h.deliver(forecast());
	h.tick('2026-09-09T18:01:00Z');
	const dot = () => h.eval('hudDrawn.ruler');
	const before = dot();
	let minute = 2;
	for (; minute < 10 && h.begins[0].length === 4 && h.begins[0][3] === 42; minute++)
		h.tick(`2026-09-09T18:0${minute}:00Z`);
	assert.ok(minute < 10, 'the marker moves within a few minutes');
	assert.deepEqual(h.begins[0], [0, 132, 200, 96]);
	assert.notEqual(dot(), before);
	assert.ok(h.texts().some(t => /^RISE /.test(t)));
	const data = forecast();
	data.weather.current.temperature_2m = 60;
	h.deliver(data);
	assert.deepEqual(h.begins[0], [0, 132, 200, 96]);
	assert.ok(h.texts().includes('60°'));
});
