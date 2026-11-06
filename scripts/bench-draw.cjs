#!/usr/bin/env node
// Host-side cost model of a launch, a relaunch and an hour of minute ticks.
//
//   node scripts/bench-draw.cjs [ticks] [label] [--ref <git-rev>] [--round]
//
// Host milliseconds say little about the watch, so this also counts what is
// expensive there. XS on the watch keeps no string index cache: charCodeAt(i)
// walks the UTF-8 string from its start, so "stringWalk" adds i + 1 per call,
// and the XS-only ArrayBuffer.fromString / String.fromArrayBuffer are
// emulated at one step per byte. Doubles are soft-float on the Cortex-M33, so
// each asin/atan2/sqrt/sin/cos call is counted, and each fillRectangle is a
// native call. --ref benchmarks a committed version (all three modules).
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {execFileSync} = require('node:child_process');
const wire = require('../tests/wire.cjs');

const ROOT = path.join(__dirname, '..');
let ref = null;
let round = false;
const positional = [];
for (let i = 2; i < process.argv.length; i++) {
	if (process.argv[i] === '--ref')
		ref = process.argv[++i];
	else if (process.argv[i] === '--round')
		round = true;
	else
		positional.push(process.argv[i]);
}
const TICKS = Number(positional[0] || 60);
const label = positional[1] || (ref || 'working-tree') + (round ? '-round' : '');
const W = round ? 260 : 200;
const H = round ? 260 : 228;
const MAP_H = round ? 150 : 132;

function source(file) {
	const rel = `src/embeddedjs/${file}.js`;
	const text = ref
		? execFileSync('git', ['show', `${ref}:${rel}`], {cwd: ROOT, encoding: 'utf8'})
		: fs.readFileSync(path.join(ROOT, rel), 'utf8');
	return text.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
}

const COUNTED = ['asin', 'atan2', 'sqrt', 'sin', 'cos', 'acos'];

function boot(store) {
	let now = Date.UTC(2026, 8, 9, 18);
	const events = {};
	const timers = [];
	const stats = {stringWalk: 0, charCodeAt: 0, rects: 0, pixels: 0, globeRects: 0, hudRects: 0, fullBegins: 0, hudBegins: 0, storageWrites: 0};
	for (const k of COUNTED)
		stats[k] = 0;
	class Clock extends Date {
		constructor(...a) { super(...(a.length ? a : [now])); }
		static now() { return now; }
	}
	class Poco {
		constructor() {
			this.Font = class { constructor(name, size) { this.name = name; this.size = size; } };
			this.width = W;
			this.height = H;
			this.unobstructed = {width: W, height: H};
		}
		makeColor(r, g, b) { return (r << 16) | (g << 8) | b; }
		begin(...a) { if (a.length === 0) stats.fullBegins++; else stats.hudBegins++; }
		end() {}
		fillRectangle(color, x, y, width, height) {
			stats.rects++;
			stats.pixels += Math.max(0, width) * Math.max(0, height);
			if (y + height <= MAP_H) stats.globeRects++;
			else stats.hudRects++;
		}
		drawText() {}
		getTextWidth(text, font) { return String(text).length * Math.ceil(font.size * 0.5); }
	}
	class Message { constructor() {} }
	const context = vm.createContext({
		Poco, Message, screen: {}, Date: Clock, console: {log() {}}, __stats: stats,
		watch: {hour12: false, addEventListener(name, fn) { events[name] = fn; }},
		setTimeout(fn, delay) { timers.push({fn, at: now + (delay || 0)}); }, clearTimeout() {},
	});
	if (store)
		context.localStorage = {
			getItem(k) { return store.has(k) ? store.get(k) : null; },
			setItem(k, v) { stats.storageWrites++; store.set(k, String(v)); },
		};
	vm.runInContext(`
		for (const k of ${JSON.stringify(COUNTED)}) {
			const f = Math[k];
			Math[k] = function (...a) { __stats[k]++; return f.apply(Math, a); };
		}
		{
			const proto = Object.getPrototypeOf('');
			const charCodeAt = proto.charCodeAt;
			proto.charCodeAt = function (i) { __stats.charCodeAt++; __stats.stringWalk += (i | 0) + 1; return charCodeAt.call(this, i); };
			ArrayBuffer.fromString = function (s) {
				s = String(s);
				__stats.stringWalk += s.length;
				const b = new Uint8Array(s.length);
				for (let i = 0; i < s.length; i++) b[i] = charCodeAt.call(s, i);
				return b.buffer;
			};
			String.fromArrayBuffer = function (buffer) {
				const b = new Uint8Array(buffer);
				__stats.stringWalk += b.length;
				let s = '';
				for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
				return s;
			};
		}
	`, context);
	const t0 = process.hrtime.bigint();
	for (const file of ['worldmask', 'yearstars', 'main'])
		vm.runInContext(source(file), context);
	const loadNs = Number(process.hrtime.bigint() - t0);
	return {
		stats, events, loadNs,
		eval: code => vm.runInContext(code, context),
		// Runs timers due by now (setTimeout 0: the stored-payload restore, a deferred write).
		runDue() {
			for (let i = 0; i < timers.length;) {
				if (timers[i].at <= now) timers.splice(i, 1)[0].fn();
				else i++;
			}
		},
		deliver(data) { context.payload = wire(data); vm.runInContext('applyPayload(payload)', context); },
		tick(ms) { now = ms; events.minutechange({date: new Clock()}); },
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

function take(stats, ns) {
	const out = {...stats, ms: ns / 1e6};
	for (const k of Object.keys(stats))
		stats[k] = 0;
	return out;
}

function timed(h, fn) {
	const t = process.hrtime.bigint();
	fn();
	return take(h.stats, Number(process.hrtime.bigint() - t));
}

// First launch: nothing stored; the phone's forecast brings the globe.
const store = new Map();
const first = boot(store);
const bootDraw = take(first.stats, first.loadNs);
const payloadDraw = timed(first, () => { first.deliver(forecast()); first.runDue(); });

// Relaunch (a watchface reopens after every notification): the stored payload
// paints the globe before the phone answers.
const again = boot(store);
const relaunchBoot = take(again.stats, again.loadNs);
const relaunchRestore = timed(again, () => again.runDue());
const relaunch = {};
for (const k of Object.keys(relaunchBoot))
	relaunch[k] = relaunchBoot[k] + relaunchRestore[k];

// An hour of minute ticks on the first watch, two half-hour globe redraws included.
const firstTick = timed(first, () => first.tick(Date.UTC(2026, 8, 9, 18, 1)));
const steady = timed(first, () => {
	for (let i = 2; i <= TICKS; i++)
		first.tick(Date.UTC(2026, 8, 9, 18, i));
});
const steadyTicks = TICKS - 1;
for (const k of [...COUNTED, 'rects', 'globeRects', 'hudRects', 'fullBegins', 'hudBegins', 'stringWalk'])
	steady[`${k}PerTick`] = steady[k] / steadyTicks;
steady.ticks = steadyTicks;
steady.msPerTick = steady.ms / steadyTicks;

const report = {
	label,
	ref: ref || 'working tree',
	layout: round ? 'gabbro 260x260' : 'emery 200x228',
	host: process.platform,
	model: 'stringWalk = bytes XS walks for charCodeAt (no string index cache) and fromString/fromArrayBuffer',
	ticks: TICKS,
	bootDraw,
	payloadDraw,
	relaunch,
	firstTick,
	steady,
};

const outDir = path.join(ROOT, 'artifacts', 'perf');
fs.mkdirSync(outDir, {recursive: true});
const outPath = path.join(outDir, `${label}.json`);
fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
const row = (name, s) => `${name.padEnd(12)} walk ${String(s.stringWalk).padStart(9)}  asin ${String(s.asin).padStart(5)}  atan2 ${String(s.atan2).padStart(5)}  sqrt ${String(s.sqrt).padStart(5)}  rects ${String(s.rects).padStart(5)}  writes ${s.storageWrites}  ${s.ms.toFixed(2)} ms`;
process.stdout.write(`${label} (${report.layout})\n`);
process.stdout.write(row('launch', bootDraw) + '\n');
process.stdout.write(row('+ forecast', payloadDraw) + '\n');
process.stdout.write(row('relaunch', relaunch) + '\n');
process.stdout.write(row(`${steadyTicks} ticks`, steady) + '\n');
process.stdout.write(`wrote ${outPath}\n`);
