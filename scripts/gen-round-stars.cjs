#!/usr/bin/env node
// Lays the 365 year stars out for the Pebble Round 2 (gabbro) sky and writes
// the result into src/c/yearstars.c as ROUND_STAR_X / ROUND_STAR_Y.
//
// The JavaScript face ran this on the watch at every launch. The layout
// depends only on constants, so it is baked here instead. Bearings from the rectangular catalog
// clump in the round side lobes and on the rim, so the stars sit on a jittered
// hex lattice inside the visible circle, then shuffle with a fixed seed so the
// year fills evenly and nothing jumps.
//
//   node scripts/gen-round-stars.cjs           print the hex
//   node scripts/gen-round-stars.cjs --write   update yearstars.c in place
const fs = require('node:fs');
const path = require('node:path');

const STARS_C = path.join(__dirname, '../src/c/yearstars.c');
const TABLES_H = path.join(__dirname, '../src/c/tables.h');
// Must match LAYOUT_ROUND in src/c/yearlight.c (tests/c-port.cjs checks).
const ROUND_LAYOUT = {mapW: 260, mapH: 150, globeCX: 130, globeCY: 78, globeR: 70};

function cArray(src, name) {
	const body = src.match(new RegExp(`\\b${name}\\[STAR_N\\] = \\{([^}]*)\\}`))[1];
	return Uint8Array.from(body.match(/\d+/g).map(Number));
}

// The rectangular catalog positions, read from yearstars.c as data. Only
// needed for exactness if the lattice ever ran out of cells (it does not).
function catalog() {
	const src = fs.readFileSync(STARS_C, 'utf8');
	const n = Number(fs.readFileSync(TABLES_H, 'utf8').match(/#define STAR_N (\d+)/)[1]);
	return {n, x: cArray(src, 'STAR_X'), y: cArray(src, 'STAR_Y')};
}

function cRows(values) {
	const rows = [];
	for (let i = 0; i < values.length; i += 16)
		rows.push('\t' + Array.from(values.slice(i, i + 16), v => String(v).padStart(3)).join(', ') + ',');
	return rows.join('\n');
}

function roundStars(layout = ROUND_LAYOUT) {
	const {mapW: MAP_W, mapH: MAP_H, globeCX: GLOBE_CX, globeCY: GLOBE_CY, globeR: GLOBE_R} = layout;
	const {n: STAR_N, x: STAR_X, y: STAR_Y} = catalog();
	const screen = MAP_W >> 1;
	const sky2 = (screen - 2) * (screen - 2);
	const clear2 = (GLOBE_R + 4) * (GLOBE_R + 4);
	function open(x, y) {
		if (x < 1 || x > 255 || y < 1 || y + 1 >= MAP_H)
			return false;
		for (let k = 0; k < 4; k++) {
			const px = x + (k & 1 ? 1 : -1);
			const py = y + (k & 2 ? 1 : -1);
			const dx = px + 0.5 - screen;
			const dy = py + 0.5 - screen;
			if (dx * dx + dy * dy > sky2)
				return false;
		}
		const gx = x + 0.5 - GLOBE_CX;
		const gy = y + 0.5 - GLOBE_CY;
		return gx * gx + gy * gy > clear2;
	}
	function mix(n) {
		n = (n ^ (n << 13)) >>> 0;
		n = (n ^ (n >>> 17)) >>> 0;
		n = (n ^ (n << 5)) >>> 0;
		return n >>> 0;
	}
	function count(step) {
		const rowH = step * Math.sqrt(3) / 2;
		let n = 0;
		for (let row = 0, y = rowH * 0.5; y < MAP_H - 1; row++, y += rowH) {
			const y0 = y | 0;
			for (let x = (row & 1) ? step * 0.5 : 1; x < 256; x += step)
				if (open(x | 0, y0))
					n++;
		}
		return n;
	}
	let step = 6.5;
	let cells = count(step);
	while (cells < STAR_N && step > 4) {
		step -= 0.25;
		cells = count(step);
	}
	const rowH = step * Math.sqrt(3) / 2;
	const gap2 = 16;
	let seen = 0;
	let placed = 0;
	let next = 0;
	for (let row = 0, y = rowH * 0.5; y < MAP_H - 1; row++, y += rowH) {
		const y0 = y | 0;
		for (let x = (row & 1) ? step * 0.5 : 1; x < 256; x += step) {
			const x0 = x | 0;
			if (!open(x0, y0))
				continue;
			if (seen === next && placed < STAR_N) {
				const h = mix(x0 + y0 * 257);
				let px = x0;
				let py = y0;
				if (h & 4)
					px += (h & 1) ? 1 : -1;
				else
					py += (h & 2) ? 1 : -1;
				if (!open(px, py)) {
					px = x0;
					py = y0;
				} else {
					for (let j = Math.max(0, placed - 48); j < placed; j++) {
						const dx = px - STAR_X[j];
						const dy = py - STAR_Y[j];
						if (dx * dx + dy * dy < gap2) {
							px = x0;
							py = y0;
							break;
						}
					}
				}
				STAR_X[placed] = px;
				STAR_Y[placed] = py;
				placed++;
				next = (placed * cells / STAR_N) | 0;
			}
			seen++;
		}
	}
	let seed = 0x9e3779b9;
	for (let i = STAR_N - 1; i > 0; i--) {
		seed = (seed * 1664525 + 1013904223) >>> 0;
		const j = seed % (i + 1);
		const tx = STAR_X[i];
		STAR_X[i] = STAR_X[j];
		STAR_X[j] = tx;
		const ty = STAR_Y[i];
		STAR_Y[i] = STAR_Y[j];
		STAR_Y[j] = ty;
	}
	return {x: STAR_X, y: STAR_Y, placed, n: STAR_N};
}

module.exports = {ROUND_LAYOUT, roundStars, cArray};

if (require.main === module) {
	const stars = roundStars();
	if (stars.placed !== stars.n)
		throw new Error(`only ${stars.placed} of ${stars.n} stars found a lattice cell`);
	const block = `// round-stars-begin
const uint8_t ROUND_STAR_X[STAR_N] = {
${cRows(stars.x)}
};

const uint8_t ROUND_STAR_Y[STAR_N] = {
${cRows(stars.y)}
};
// round-stars-end`;
	if (process.argv.includes('--write')) {
		const src = fs.readFileSync(STARS_C, 'utf8');
		const pattern = /\/\/ round-stars-begin[\s\S]*\/\/ round-stars-end/;
		if (!pattern.test(src))
			throw new Error('round-stars markers not found in yearstars.c');
		fs.writeFileSync(STARS_C, src.replace(pattern, block));
		process.stdout.write(`wrote ROUND_STAR_X/Y to ${STARS_C}\n`);
	} else
		process.stdout.write(block + '\n');
}
