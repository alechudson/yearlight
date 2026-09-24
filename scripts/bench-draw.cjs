#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const wire = require('../tests/wire.cjs');
const vm = require('node:vm');
const {execFileSync} = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const TICKS = Number(process.argv[2] || 60);
const label = process.argv[3] || 'working-tree';
const mainSource = label === 'HEAD'
	? execFileSync('git', ['show', 'HEAD:src/embeddedjs/main.js'], {cwd: ROOT, encoding: 'utf8'})
	: fs.readFileSync(path.join(ROOT, 'src/embeddedjs/main.js'), 'utf8');

function boot(source) {
	let now = Date.UTC(2026, 8, 9, 18);
	const events = {};
	const stats = {asin: 0, atan2: 0, sqrt: 0, sin: 0, cos: 0, rects: 0, pixels: 0, globeRects: 0, hudRects: 0, fullBegins: 0, hudBegins: 0};
	const math = {
		PI: Math.PI,
		max: Math.max,
		min: Math.min,
		round: Math.round,
		floor: Math.floor,
		abs: Math.abs,
		asin(x) { stats.asin++; return Math.asin(x); },
		atan2(y, x) { stats.atan2++; return Math.atan2(y, x); },
		sqrt(x) { stats.sqrt++; return Math.sqrt(x); },
		sin(x) { stats.sin++; return Math.sin(x); },
		cos(x) { stats.cos++; return Math.cos(x); },
	};
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
			if (args.length === 0)
				stats.fullBegins++;
			else
				stats.hudBegins++;
		}
		end() {}
		fillRectangle(color, x, y, width, height) {
			stats.rects++;
			const pixels = Math.max(0, width) * Math.max(0, height);
			stats.pixels += pixels;
			if (y + height <= 132) stats.globeRects++;
			else stats.hudRects++;
		}
		drawText(text, font) { return String(text).length * Math.ceil(font.size * 0.5); }
		getTextWidth(text, font) { return String(text).length * Math.ceil(font.size * 0.5); }
	}
	class Message { constructor() {} }
	const context = vm.createContext({
		Poco, Message, screen: {}, Date: Clock, Math: math, Number, String, Array, Map, Uint8Array, JSON, console: {log() {}},
		watch: {hour12: false, addEventListener(name, fn) { events[name] = fn; }},
		setTimeout() {}, clearTimeout() {},
	});
	for (const file of ['worldmask', 'yearstars']) {
		const src = fs.readFileSync(path.join(ROOT, `src/embeddedjs/${file}.js`), 'utf8')
			.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
		vm.runInContext(src, context);
	}
	vm.runInContext(source.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, ''), context);
	const evaluate = code => vm.runInContext(code, context);
	return {
		stats, events, eval: evaluate,
		deliver(data) { context.payload = wire(data); evaluate('applyPayload(payload)'); },
		tick(iso) { now = Date.parse(iso); events.minutechange({date: new Clock()}); },
		resetStats() {
			stats.asin = stats.atan2 = stats.sqrt = stats.sin = stats.cos = 0;
			stats.rects = stats.pixels = stats.globeRects = stats.hudRects = 0;
			stats.fullBegins = stats.hudBegins = 0;
		},
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

function snapshot(stats) {
	return {
		asin: stats.asin, atan2: stats.atan2, sqrt: stats.sqrt, sin: stats.sin, cos: stats.cos,
		rects: stats.rects, pixels: stats.pixels, globeRects: stats.globeRects, hudRects: stats.hudRects,
		fullBegins: stats.fullBegins, hudBegins: stats.hudBegins,
	};
}

const h = boot(mainSource);
const bootDraw = snapshot(h.stats);
h.resetStats();
const tPayload = process.hrtime.bigint();
h.deliver(forecast());
const payloadNs = Number(process.hrtime.bigint() - tPayload);
const payloadDraw = snapshot(h.stats);

h.resetStats();
const t0 = process.hrtime.bigint();
h.tick('2026-09-09T18:01:00Z');
const firstNs = Number(process.hrtime.bigint() - t0);
const first = snapshot(h.stats);

h.resetStats();
const t1 = process.hrtime.bigint();
for (let i = 2; i <= TICKS; i++)
	h.tick(new Date(Date.UTC(2026, 8, 9, 18, i)).toISOString());
const steadyNs = Number(process.hrtime.bigint() - t1);
const steadyTicks = TICKS - 1;
const steady = snapshot(h.stats);

const report = {
	label,
	host: process.platform,
	ticks: TICKS,
	bootDraw,
	payloadDraw: {...payloadDraw, ns: payloadNs, ms: payloadNs / 1e6},
	firstTick: {...first, ns: firstNs, ms: firstNs / 1e6},
	steady: {
		...steady,
		ticks: steadyTicks,
		ns: steadyNs,
		ms: steadyNs / 1e6,
		msPerTick: (steadyNs / 1e6) / steadyTicks,
		asinPerTick: steady.asin / steadyTicks,
		atan2PerTick: steady.atan2 / steadyTicks,
		sqrtPerTick: steady.sqrt / steadyTicks,
		sinPerTick: steady.sin / steadyTicks,
		cosPerTick: steady.cos / steadyTicks,
		rectsPerTick: steady.rects / steadyTicks,
		globeRectsPerTick: steady.globeRects / steadyTicks,
		hudRectsPerTick: steady.hudRects / steadyTicks,
		fullBeginsPerTick: steady.fullBegins / steadyTicks,
		hudBeginsPerTick: steady.hudBegins / steadyTicks,
	},
};

const outDir = path.join(ROOT, 'artifacts', 'perf');
fs.mkdirSync(outDir, {recursive: true});
const outPath = path.join(outDir, `${label}.json`);
fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
process.stdout.write(`wrote ${outPath}\n`);
