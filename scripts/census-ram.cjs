#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(ROOT, 'src/embeddedjs/main.js'), 'utf8');
const mask = fs.readFileSync(path.join(ROOT, 'src/embeddedjs/worldmask.js'), 'utf8');
const stars = fs.readFileSync(path.join(ROOT, 'src/embeddedjs/yearstars.js'), 'utf8');
const c = fs.readFileSync(path.join(ROOT, 'src/c/mdbl.c'), 'utf8');

function countHexArrayNumbers(src) {
	const matches = src.match(/0x[0-9a-fA-F]+|\b\d+\b/g) || [];
	return matches.length;
}

const iconBlock = main.slice(main.indexOf('const WEATHER_ICONS'), main.indexOf('function drawWeatherIcon'));
const moonBlock = main.slice(main.indexOf('const MOON_PHASES'), main.indexOf('function moonPhaseIndex'));
const report = {
	files: {
		mainBytes: main.length,
		worldmaskBytes: mask.length,
		yearstarsBytes: stars.length,
	},
	pools: {
		stack: Number((c.match(/\.stack = (\d+)/) || [])[1]),
		slot: Number((c.match(/\.slot = (\d+)/) || [])[1]),
		chunk: Number((c.match(/\.chunk = (\d+)/) || [])[1]),
	},
	appMessage: {
		input: Number((main.match(/input: (\d+)/) || [])[1]),
		output: Number((main.match(/output: (\d+)/) || [])[1]),
	},
	liveData: {
		maskBytes: 200 * 100 / 8,
		starBytes: 365 * 3,
		weatherIconNumbers: countHexArrayNumbers(iconBlock),
		moonPhaseNumbers: countHexArrayNumbers(moonBlock),
		fonts: 3,
	},
	reservedNative: null,
};
report.reservedNative = report.pools.stack + report.pools.slot + report.pools.chunk
	+ report.appMessage.input + report.appMessage.output;

process.stdout.write(JSON.stringify(report, null, 2) + '\n');
const out = path.join(ROOT, 'artifacts', 'perf', 'ram-census.json');
fs.mkdirSync(path.dirname(out), {recursive: true});
fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
process.stdout.write(`wrote ${out}\n`);
