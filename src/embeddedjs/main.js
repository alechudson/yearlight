import Poco from "commodetto/Poco";
import Message from "pebble/message";
import { isLandCell, MASK_W, MASK_H } from "worldmask";
import { STAR_N, STAR_X, STAR_Y, STAR_SHAPE, litStarCount, seasonStars, useRoundStars } from "yearstars";

const render = new Poco(screen);

// Round 2 (gabbro, 260x260) stacks the same sky-over-HUD layout inside the
// circle: a larger globe, and HUD rows pulled in from the curved edge.
const ROUND = render.width > 0 && render.width === render.height;
let LAYOUT = ROUND ? {
	mapW: 260, mapH: 150, globeCY: 78, globeR: 70,
	captionY: 192, captionInset: 30,
	rulerY: 216, solarLabelY: 221, rulerInset: 40, solarLabelInset: 56,
} : {
	mapW: 200, mapH: 132, globeCY: 66, globeR: 64,
	// The bottom row stays clear of the rounded screen corners the appstore's
	// Time 2 frame draws over screenshots.
	captionY: 174, captionInset: 9,
	rulerY: 200, solarLabelY: 205, rulerInset: 16, solarLabelInset: 16,
};
const MAP_W = LAYOUT.mapW;
const MAP_H = LAYOUT.mapH;
const GLOBE_CX = MAP_W / 2;
const GLOBE_CY = LAYOUT.globeCY;
const GLOBE_R = LAYOUT.globeR;
const CAPTION_Y = LAYOUT.captionY;
const CAPTION_INSET = LAYOUT.captionInset;
const RULER_Y = LAYOUT.rulerY;
const SOLAR_LABEL_Y = LAYOUT.solarLabelY;
const SOLAR_INSET = LAYOUT.rulerInset;
const SOLAR_LABEL_INSET = LAYOUT.solarLabelInset;
// Only startup reads the table; release it like the star and mask hex.
LAYOUT = null;

const timeFont = new render.Font("Bitham-Bold", 42);
const dateFont = new render.Font("Gothic-Bold", 18);
const smallFont = new render.Font("Gothic-Bold", 14);

const black = render.makeColor(0, 0, 0);
const white = render.makeColor(255, 255, 255);
const yellow = render.makeColor(255, 255, 0);
const cyan = render.makeColor(0, 255, 255);
const darkGray = render.makeColor(85, 85, 85);
const lightGray = render.makeColor(170, 170, 170);
const deepBlue = render.makeColor(0, 0, 170);
const dayOcean = render.makeColor(0, 0, 255);
const nightOcean = render.makeColor(0, 0, 85);
const dayLand = render.makeColor(0, 255, 0);
const nightLand = render.makeColor(0, 85, 0);

const THEMES = [
	{ sky: black, paper: white, ink: black, muted: darkGray, star: white, season: cyan },
	{ sky: black, paper: black, ink: white, muted: lightGray, star: white, season: cyan },
	{ sky: white, paper: white, ink: black, muted: darkGray, star: black, season: deepBlue },
	{ sky: darkGray, paper: darkGray, ink: white, muted: white, star: white, season: cyan },
	{ sky: black, paper: darkGray, ink: white, muted: white, star: white, season: cyan },
];
let theme = THEMES[0];

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
	"Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const state = {
	status: "loading",
	weather: null,
	lat: null,
	lon: null,
};

let lastDate = new Date();
let phoneWritable = false;
let defaultGlobe = false;
const phone = new Message({
	// Array order is the message key number: package.json lists PAYLOAD, CMD, THEME.
	keys: ["PAYLOAD", "CMD", "THEME"],
	input: 1024,
	output: 256,
	onReadable() {
		const msg = this.read();
		applyTheme(msg.get("THEME"));
		const payload = msg.get("PAYLOAD");
		if (payload)
			applyPayload(payload);
	},
	onWritable() {
		phoneWritable = true;
	},
	onSuspend() {
		phoneWritable = false;
	}
});

function sunAt(now) {
	// Low-precision solar coordinates (Astronomical Almanac): about 0.01° in
	// declination and a few seconds of equation of time, with no drift across years.
	const n = now.getTime() / 86400000 - 10957.5;
	const rad = Math.PI / 180;
	const mean = (280.460 + 0.9856474 * n) % 360;
	const g = (357.528 + 0.9856003 * n) * rad;
	const lambda = (mean + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * rad;
	const tilt = (23.439 - 0.0000004 * n) * rad;
	const ra = Math.atan2(Math.cos(tilt) * Math.sin(lambda), Math.cos(lambda)) / rad;
	const equation = 4 * (((mean - ra) % 360 + 540) % 360 - 180);
	const declination = Math.asin(Math.sin(tilt) * Math.sin(lambda));
	const minutes = now.getUTCHours() * 60 + now.getUTCMinutes() + now.getUTCSeconds() / 60;
	// Map x=0 is longitude -180; map y grows southward.
	const x = 2 * Math.PI - (minutes + equation) * Math.PI / 720;
	const y = -declination;
	return {
		sinX: Math.sin(x),
		cosX: Math.cos(x),
		sinY: Math.sin(y),
		cosY: Math.cos(y),
		lon: x * 180 / Math.PI - 180,
		lat: declination * 180 / Math.PI,
	};
}

// sin(-0.833°): NOAA apparent sunrise (refraction + solar radius). Same cost as < 0.
const NIGHT_SIN = Math.sin(-0.833 * Math.PI / 180);

const GLOBE_TILT_MAX = 40;

function isNightLonLat(lon, lat, sun) {
	const xA = (lon + 180) * Math.PI / 180;
	const latR = lat * Math.PI / 180;
	return sun.sinY * Math.sin(-latR) + sun.cosY * Math.cos(latR) * (sun.cosX * Math.cos(xA) + sun.sinX * Math.sin(xA)) < NIGHT_SIN;
}

function projectGlobe(lon, lat, lon0, sinLat0, cosLat0) {
	const latR = lat * Math.PI / 180;
	const dlon = lon * Math.PI / 180 - lon0;
	const sinLat = Math.sin(latR);
	const cosLat = Math.cos(latR);
	if (sinLat0 * sinLat + cosLat0 * cosLat * Math.cos(dlon) < 0)
		return null;
	return {
		x: (GLOBE_CX + GLOBE_R * cosLat * Math.sin(dlon)) | 0,
		y: (GLOBE_CY - GLOBE_R * (cosLat0 * sinLat - sinLat0 * cosLat * Math.cos(dlon))) | 0,
	};
}

function pad2(n) {
	return String(n).padStart(2, "0");
}

function formatTime(now) {
	if (watch.hour12) {
		let hours = now.getHours() % 12;
		if (hours === 0)
			hours = 12;
		return String(hours) + ":" + pad2(now.getMinutes());
	}
	return pad2(now.getHours()) + ":" + pad2(now.getMinutes());
}

function moodFor(code) {
	// Open-Meteo WMO weather interpretation codes.
	switch (code) {
		case 0: return "CLEAR";
		case 1: case 2: case 3: return "CLOUD";
		case 45: case 48: return "FOG";
		case 51: case 53: case 55: case 56: case 57: return "DRIZL";
		case 61: case 63: case 65: case 66: case 67: return "RAIN";
		case 71: case 73: case 75: case 77: case 85: case 86: return "SNOW";
		case 80: case 81: case 82: return "SHWR";
		case 95: case 96: case 99: return "STORM";
	}
}

function isLand(lon, lat) {
	let x = ((lon + 180) / 360 * MASK_W) | 0;
	let y = ((90 - lat) / 180 * MASK_H) | 0;
	x = ((x % MASK_W) + MASK_W) % MASK_W;
	if (y < 0)
		y = 0;
	else if (y >= MASK_H)
		y = MASK_H - 1;
	return isLandCell(x, y);
}

function viewOrigin() {
	if (state.lat !== null) {
		let lat = state.lat;
		if (lat > GLOBE_TILT_MAX)
			lat = GLOBE_TILT_MAX;
		else if (lat < -GLOBE_TILT_MAX)
			lat = -GLOBE_TILT_MAX;
		return { lon: state.lon, lat };
	}
	return { lon: -90, lat: 15 };
}

const TERMINATOR_MS = 30 * 60 * 1000;
const globeDrawn = { lon: 9999, lat: 9999, step: -1, stars: -1 };
const GLOBE_COLORS = [dayOcean, nightOcean, dayLand, nightLand];

// Globe samples sit on even pixels and read the pixel center at +1; these bound
// the ones inside the disc, so the sky around the globe costs no work.
const GLOBE_X0 = Math.max(0, (GLOBE_CX - GLOBE_R) & ~1);
const GLOBE_X1 = Math.min(MAP_W - 2, (GLOBE_CX + GLOBE_R - 1) & ~1) + 2;
const GLOBE_Y0 = Math.max(0, (GLOBE_CY - GLOBE_R) & ~1);
const GLOBE_Y1 = Math.min(MAP_H - 2, (GLOBE_CY + GLOBE_R - 1) & ~1) + 2;

// The globe is drawn from rows of 2x2 samples. Row r is y = GLOBE_Y0 + 2r and
// sample i is x = GLOBE_X0 + 2i; the disc covers samples spanA[r]..spanB[r] of
// a row (NO_SPAN: none). The work then goes by runs, not by samples: a row
// paints one rectangle wherever its land or its side of the terminator changes.
const SAMPLE_W = (GLOBE_X1 - GLOBE_X0) >> 1;
const SAMPLE_ROWS = (GLOBE_Y1 - GLOBE_Y0) >> 1;
const NO_SPAN = 255;
const spanA = new Uint8Array(SAMPLE_ROWS);
const spanB = new Uint8Array(SAMPLE_ROWS);
// A symmetric box mirrors sample i to SAMPLE_W - 1 - i (x to -x).
const MIRROR = GLOBE_X0 + GLOBE_X1 === 2 * GLOBE_CX;

function inDisc(i, yy) {
	const xn = (GLOBE_X0 + 2 * i + 1 - GLOBE_CX) / GLOBE_R;
	return xn * xn + yy <= 1;
}

for (let r = 0; r < SAMPLE_ROWS; r++) {
	const yn = (GLOBE_CY - (GLOBE_Y0 + 2 * r + 1)) / GLOBE_R;
	const yy = yn * yn;
	let a = 0;
	let b = -1;
	if (yy <= 1) {
		// Estimate the run from the circle, then settle it on the exact test.
		const half = Math.sqrt(1 - yy) * GLOBE_R;
		a = Math.floor((GLOBE_CX - half - 1 - GLOBE_X0) / 2);
		b = Math.floor((GLOBE_CX + half - 1 - GLOBE_X0) / 2);
		a = a < 0 ? 0 : a > SAMPLE_W ? SAMPLE_W : a;
		b = b < -1 ? -1 : b > SAMPLE_W - 1 ? SAMPLE_W - 1 : b;
		while (a > 0 && inDisc(a - 1, yy))
			a--;
		while (b < SAMPLE_W - 1 && inDisc(b + 1, yy))
			b++;
		while (a <= b && !inDisc(a, yy))
			a++;
		while (b >= a && !inDisc(b, yy))
			b--;
	}
	spanA[r] = a <= b ? a : NO_SPAN;
	spanB[r] = a <= b ? b : 0;
}

// Land along each row, as the samples where it flips between water and land:
// row r starts on water at spanA[r] and flips at landT[landOff[r]..landOff[r + 1]).
// Land depends only on the view origin, so the asin/atan2 inverse projection
// runs on relocation, not on every terminator step, and the rows are stored
// so a relaunch (after every notification, for a watchface) skips it too.
let landT = new Uint8Array(512);
const landOff = new Uint16Array(SAMPLE_ROWS + 1);
const landFor = { lon: 9999, lat: 9999 };
const rowLand = new Uint8Array(SAMPLE_W);
let landDirty = false;
let landSaving = false;

function landFlip(n, t) {
	if (n === landT.length) {
		const grown = new Uint8Array(n * 2);
		grown.set(landT);
		landT = grown;
	}
	landT[n] = t;
	return n + 1;
}

function wrapLon(lon) {
	return ((lon + 180) % 360 + 360) % 360 - 180;
}

// Mirror samples share z and the latitude, and atan2 is odd in x, so a
// symmetric row needs one inverse projection per pair.
function computeLand(lon0, sinLat0, cosLat0) {
	let n = 0;
	for (let r = 0; r < SAMPLE_ROWS; r++) {
		landOff[r] = n;
		const a = spanA[r];
		if (a === NO_SPAN)
			continue;
		const b = spanB[r];
		const mirror = MIRROR && a + b === SAMPLE_W - 1;
		const last = mirror ? (a + b) >> 1 : b;
		const yn = (GLOBE_CY - (GLOBE_Y0 + 2 * r + 1)) / GLOBE_R;
		for (let i = a; i <= last; i++) {
			const xn = (GLOBE_X0 + 2 * i + 1 - GLOBE_CX) / GLOBE_R;
			const rr = xn * xn + yn * yn;
			const z = Math.sqrt(1 - rr);
			const lat = Math.asin(Math.max(-1, Math.min(1, yn * cosLat0 + z * sinLat0))) * 180 / Math.PI;
			const t = Math.atan2(xn, z * cosLat0 - yn * sinLat0);
			rowLand[i] = isLand(wrapLon((lon0 + t) * 180 / Math.PI), lat);
			if (mirror && a + b - i !== i)
				rowLand[a + b - i] = isLand(wrapLon((lon0 - t) * 180 / Math.PI), lat);
		}
		let land = 0;
		for (let i = a; i <= b; i++) {
			if (rowLand[i] !== land) {
				land ^= 1;
				n = landFlip(n, i);
			}
		}
	}
	landOff[SAMPLE_ROWS] = n;
}

// Stored as "format,MAP_W,lon,lat," and then, row by row, each flip as the
// character 48 + sample and "/" to end the row.
const LAND_KEY = "ld";
// Bump when worldmask.js or the projection changes, so stored rows are redone.
const LAND_FORMAT = 1;

function landTag(origin) {
	return LAND_FORMAT + "," + MAP_W + "," + origin.lon + "," + origin.lat + ",";
}

// A string's bytes, and bytes back to a string, in one pass with the XS
// extensions (charCodeAt walks the string from its start on the watch); plain
// loops where they are missing, as in the host tests. Stored text is ASCII.
function stringChars(text) {
	if (typeof ArrayBuffer.fromString === "function")
		return new Uint8Array(ArrayBuffer.fromString(text));
	const chars = new Uint8Array(text.length);
	for (let i = 0; i < text.length; i++)
		chars[i] = text.charCodeAt(i);
	return chars;
}

function charsString(chars) {
	if (typeof String.fromArrayBuffer === "function")
		return String.fromArrayBuffer(chars.buffer);
	let text = "";
	for (let i = 0; i < chars.length; i++)
		text += String.fromCharCode(chars[i]);
	return text;
}

function restoreLand(tag) {
	let text;
	try {
		text = localStorage.getItem(LAND_KEY);
	} catch (e) {
		return false;
	}
	if (typeof text !== "string" || !text.startsWith(tag))
		return false;
	const chars = stringChars(text.slice(tag.length));
	let k = 0;
	let n = 0;
	for (let r = 0; r < SAMPLE_ROWS; r++) {
		landOff[r] = n;
		const a = spanA[r];
		const b = spanB[r];
		let last = -1;
		for (;;) {
			if (k >= chars.length)
				return false;
			const c = chars[k++];
			if (c === 47)
				break;
			const t = c - 48;
			if (a === NO_SPAN || t < a || t > b || t <= last)
				return false;
			n = landFlip(n, t);
			last = t;
		}
	}
	landOff[SAMPLE_ROWS] = n;
	return k === chars.length;
}

function saveLand() {
	landSaving = false;
	if (!landDirty)
		return;
	landDirty = false;
	const chars = new Uint8Array(landOff[SAMPLE_ROWS] + SAMPLE_ROWS);
	let k = 0;
	for (let r = 0; r < SAMPLE_ROWS; r++) {
		for (let i = landOff[r]; i < landOff[r + 1]; i++)
			chars[k++] = 48 + landT[i];
		chars[k++] = 47;
	}
	try {
		localStorage.setItem(LAND_KEY, landTag(landFor) + charsString(chars));
	} catch (e) {
	}
}

function loadLand(origin, lon0, sinLat0, cosLat0) {
	if (restoreLand(landTag(origin)))
		landDirty = false;
	else {
		computeLand(lon0, sinLat0, cosLat0);
		landDirty = true;
		// Write once this frame is out, rather than hold up its paint.
		if (!landSaving) {
			landSaving = true;
			setTimeout(saveLand, 0);
		}
	}
	landFor.lon = origin.lon;
	landFor.lat = origin.lat;
}

// Night where vx * xn + vy * yn + vz * z < NIGHT_SIN, as isNightLonLat would
// say for the sample's place. Along a row z = sqrt(1 - yn^2 - xn^2), so this
// changes at most twice, at roots of a quadratic in xn. The samples beside each
// root are tested exactly; between them the side cannot change, so a row costs
// a handful of square roots instead of one per sample.
let shadeX = 0;
let shadeY = 0;
let shadeZ = 0;
let shadeA2 = 0;
const probeAt = new Int16Array(12);
const nightFlips = new Uint8Array(SAMPLE_W + 1);
let nightCount = 0;

function nightAt(i, vyyn, yy) {
	const xn = (GLOBE_X0 + 2 * i + 1 - GLOBE_CX) / GLOBE_R;
	return shadeX * xn + vyyn + shadeZ * Math.sqrt(1 - (xn * xn + yy)) < NIGHT_SIN ? 1 : 0;
}

// Fills nightFlips[0..nightCount) with the samples in a + 1..b where night
// changes, and returns whether sample a is night.
function nightRow(a, b, yn) {
	const yy = yn * yn;
	const vyyn = shadeY * yn;
	let probes = 0;
	probeAt[probes++] = a;
	if (shadeA2 > 1e-12) {
		const c = NIGHT_SIN - vyyn;
		const d = shadeA2 * (1 - yy) - c * c;
		// A near-zero d is a terminator grazing the row: probe the tangent too.
		if (d > -1e-6) {
			const s = d > 0 ? Math.sqrt(d) * Math.abs(shadeZ) : 0;
			for (let k = -1; k <= 1; k += 2) {
				const root = (c * shadeX + k * s) / shadeA2;
				const u = Math.floor((root * GLOBE_R + GLOBE_CX - 1 - GLOBE_X0) / 2);
				for (let i = u - 1; i <= u + 2; i++) {
					const p = i < a ? a : i > b ? b : i;
					if (p > probeAt[probes - 1])
						probeAt[probes++] = p;
				}
			}
		}
	}
	if (b > probeAt[probes - 1])
		probeAt[probes++] = b;
	const first = nightAt(a, vyyn, yy);
	let side = first;
	let n = 0;
	for (let k = 1; k < probes; k++) {
		const i = probeAt[k];
		const v = nightAt(i, vyyn, yy);
		if (v === side)
			continue;
		// Probes come in runs of neighbours; a wider gap never holds a root,
		// but walk it sample by sample if its ends ever disagree.
		for (let g = probeAt[k - 1] + 1; g < i; g++) {
			if (nightAt(g, vyyn, yy) !== side) {
				nightFlips[n++] = g;
				side ^= 1;
			}
		}
		if (v !== side) {
			nightFlips[n++] = i;
			side = v;
		}
	}
	nightCount = n;
	return first;
}

function drawMap(sun, origin) {
	const lon0 = origin.lon * Math.PI / 180;
	const lat0 = origin.lat * Math.PI / 180;
	const sinLat0 = Math.sin(lat0);
	const cosLat0 = Math.cos(lat0);
	const sinLon0 = Math.sin(lon0);
	const cosLon0 = Math.cos(lon0);
	if (landFor.lon !== origin.lon || landFor.lat !== origin.lat)
		loadLand(origin, lon0, sinLat0, cosLat0);
	// isNightLonLat as a dot product: the sun's direction rotated into the globe's
	// view frame, so each sample needs no trig to find its side of the terminator.
	const sunX = -sun.cosY * sun.cosX;
	const sunY = -sun.cosY * sun.sinX;
	const sunZ = -sun.sinY;
	const toward = sunX * cosLon0 + sunY * sinLon0;
	shadeX = sunY * cosLon0 - sunX * sinLon0;
	shadeY = sunZ * cosLat0 - toward * sinLat0;
	shadeZ = toward * cosLat0 + sunZ * sinLat0;
	shadeA2 = shadeX * shadeX + shadeZ * shadeZ;
	render.fillRectangle(theme.sky, 0, 0, MAP_W, MAP_H);
	for (let r = 0; r < SAMPLE_ROWS; r++) {
		const a = spanA[r];
		if (a === NO_SPAN)
			continue;
		const end = spanB[r] + 1;
		const y = GLOBE_Y0 + 2 * r;
		let night = nightRow(a, end - 1, (GLOBE_CY - (y + 1)) / GLOBE_R);
		let land = 0;
		let li = landOff[r];
		const le = landOff[r + 1];
		let ni = 0;
		let p = a;
		for (;;) {
			const lt = li < le ? landT[li] : end;
			const nt = ni < nightCount ? nightFlips[ni] : end;
			const e = lt < nt ? lt : nt;
			if (e > p) {
				render.fillRectangle(GLOBE_COLORS[land * 2 + night], GLOBE_X0 + 2 * p, y, 2 * (e - p), 2);
				p = e;
			}
			if (e === end)
				break;
			if (lt === e) {
				land ^= 1;
				li++;
			}
			if (nt === e) {
				night ^= 1;
				ni++;
			}
		}
	}
}

if (ROUND)
	useRoundStars();

function drawYearStars(now) {
	const lit = litStarCount(now);
	const season = seasonStars(now.getFullYear());
	let next = 0;
	for (let i = 0; i < STAR_N; i++) {
		const isSeason = next < 4 && season[next] === i;
		if (isSeason)
			next++;
		else if (i >= lit) {
			// Past today only the season stars show: skip to the next one.
			if (next === 4)
				break;
			i = season[next] - 1;
			continue;
		}
		const color = isSeason ? theme.season : theme.star;
		const x = STAR_X[i];
		const y = STAR_Y[i];
		const shape = STAR_SHAPE[i];
		if (shape === 0)
			render.fillRectangle(color, x, y, 1, 1);
		else if (shape === 1)
			render.fillRectangle(color, x, y, 2, 1);
		else if (shape === 2) {
			render.fillRectangle(color, x - 1, y, 3, 1);
			render.fillRectangle(color, x, y - 1, 1, 3);
		} else
			render.fillRectangle(color, x - 1, y - 1, 3, 3);
	}
}

// 16px monochrome pictograms; no bitmap resources or per-frame allocations.
const WEATHER_ICONS = {
	CLEAR: [0x0180,0x0180,0x2004,0x1008,0x03c0,0x07e0,0x0ff0,0xcff3,0xcff3,0x0ff0,0x07e0,0x03c0,0x1008,0x2004,0x0180,0x0180],
	MOON: [0x03c0,0x0780,0x0f00,0x1e00,0x1e00,0x3c00,0x3c00,0x3c00,0x3e00,0x3e00,0x1f02,0x1f86,0x0ffe,0x07fc,0x03f8,0x00e0],
	CLOUD: [0,0,0x03c0,0x07e0,0x0ff0,0x1ff8,0x7ffc,0xfffe,0xfffe,0xfffe,0x7ffc,0,0,0,0,0],
	FOG: [0,0x03c0,0x07e0,0x0ff0,0x3ffc,0x7ffe,0x3ffc,0,0,0x7ff8,0x7ff8,0,0x1ffe,0x1ffe,0,0],
	RAIN: [0,0x03c0,0x07e0,0x0ff0,0x3ffc,0x7ffe,0x7ffe,0x3ffc,0,0,0x1110,0x2220,0x4440,0,0x1110,0x2220],
	SNOW: [0,0,0x0180,0x2184,0x318c,0x1998,0x0db0,0x07e0,0x7ffe,0x07e0,0x0db0,0x1998,0x318c,0x2184,0x0180,0],
	STORM: [0,0x03c0,0x07e0,0x0ff0,0x3ffc,0x7ffe,0x7ffe,0x3ffc,0x0300,0x0600,0x0c00,0x1f80,0x0300,0x0600,0x0c00,0x0800],
};

function iconMood(now, phase) {
	if (!state.weather)
		return null;
	let mood = moodFor(state.weather.code);
	if (mood === "DRIZL" || mood === "SHWR")
		mood = "RAIN";
	if (mood === "CLEAR" && (phase ? phase.night : isNightLonLat(state.lon, state.lat, sunAt(now))))
		mood = "MOON";
	return mood;
}

// One rectangle per horizontal run of set bits; `scale` is the pixel size.
function drawBitRows(rows, width, x, y, scale, color) {
	const top = 1 << (width - 1);
	for (let row = 0; row < rows.length; row++) {
		const bits = rows[row];
		let col = 0;
		while (col < width) {
			if (!(bits & (top >> col))) {
				col++;
				continue;
			}
			const start = col;
			while (col < width && (bits & (top >> col)))
				col++;
			render.fillRectangle(color, x + start * scale, y + row * scale, (col - start) * scale, scale);
		}
	}
}

function drawWeatherIcon(mood, x, y, color) {
	if (mood)
		drawBitRows(WEATHER_ICONS[mood], 16, x, y, 1, color);
}

// A null offset means the watch's own time zone.
function formatSolarTime(date, offset) {
	if (!date)
		return "--:--";
	const utc = offset !== null;
	const local = utc ? new Date(date.getTime() + offset * 1000) : date;
	const hours = utc ? local.getUTCHours() : local.getHours();
	const minutes = utc ? local.getUTCMinutes() : local.getMinutes();
	if (watch.hour12)
		return (hours % 12 || 12) + ":" + pad2(minutes) + (hours < 12 ? "a" : "p");
	return pad2(hours) + ":" + pad2(minutes);
}

// Sunrise and sunset from sunAt when the forecast has none for now: the phone
// away for days, or the forecast service gone. Solar noon is when the subsolar
// longitude reaches the place; one correction step lands within a minute.
function computedSolarDay(k, lat, lon) {
	let t = (k + 0.5 - lon / 360) * 86400000;
	let sun = sunAt(new Date(t));
	t += ((sun.lon - lon + 540) % 360 - 180) * 240000;
	sun = sunAt(new Date(t));
	const latR = lat * Math.PI / 180;
	const decR = sun.lat * Math.PI / 180;
	const cosH = (NIGHT_SIN - Math.sin(latR) * Math.sin(decR)) / (Math.cos(latR) * Math.cos(decR));
	// Polar day or night: no sunrise or sunset to draw.
	if (!(cosH >= -1 && cosH <= 1))
		return { day: k, sunrise: null, sunset: null };
	const half = Math.acos(cosH) / Math.PI * 43200000;
	return { day: k, sunrise: new Date(t - half), sunset: new Date(t + half) };
}

const computedSolar = { k: NaN, lat: NaN, lon: NaN, days: null };

function computedSolarDays(now, lat, lon) {
	const k = Math.floor(now.getTime() / 86400000 + lon / 360);
	if (computedSolar.k !== k || computedSolar.lat !== lat || computedSolar.lon !== lon) {
		computedSolar.days = [computedSolarDay(k - 1, lat, lon), computedSolarDay(k, lat, lon), computedSolarDay(k + 1, lat, lon)];
		computedSolar.k = k;
		computedSolar.lat = lat;
		computedSolar.lon = lon;
	}
	return computedSolar.days;
}

function solarPhaseFor(now) {
	const weather = state.weather;
	const phase = weather && solarPhaseIn(weather.solarDays, now);
	if (phase || state.lat === null)
		return phase || null;
	const computed = solarPhaseIn(computedSolarDays(now, state.lat, state.lon), now);
	// Forecast offsets are for the forecast place; otherwise show watch time.
	if (computed)
		computed.offset = weather ? weather.utcOffset : null;
	return computed;
}

function solarPhaseIn(days, now) {
	for (let i = 0; i < days.length; i++) {
		const day = days[i];
		if (day.sunrise && day.sunset && day.sunrise <= now && now < day.sunset)
			return { night: false, start: day.sunrise, end: day.sunset };
		const next = days[i + 1];
		if (next && next.day === day.day + 1 && day.sunset && next.sunrise
			&& day.sunset <= now && now < next.sunrise)
			return { night: true, start: day.sunset, end: next.sunrise };
	}
	return null;
}

const MOON_PHASES = [
	[0x1c, 0x22, 0x41, 0x41, 0x41, 0x22, 0x1c],
	[0x04, 0x0e, 0x0f, 0x0f, 0x0f, 0x0e, 0x04],
	[0x0c, 0x1e, 0x1f, 0x1f, 0x1f, 0x1e, 0x0c],
	[0x1c, 0x3e, 0x3f, 0x3f, 0x3f, 0x3e, 0x1c],
	[0x1c, 0x3e, 0x7f, 0x7f, 0x7f, 0x3e, 0x1c],
	[0x1c, 0x3e, 0x7e, 0x7e, 0x7e, 0x3e, 0x1c],
	[0x18, 0x3c, 0x7c, 0x7c, 0x7c, 0x3c, 0x18],
	[0x10, 0x38, 0x78, 0x78, 0x78, 0x38, 0x10],
];

function moonPhaseIndex(now) {
	// Meeus, Astronomical Algorithms: new moon JDE 2451550.1, synodic month.
	const jd = now.getTime() / 86400000 + 2440587.5;
	let phase = (jd - 2451550.1) / 29.530588853;
	phase -= Math.floor(phase);
	return Math.round(phase * 8) % 8;
}

function drawMoonPhase(index, x, y, color) {
	drawBitRows(MOON_PHASES[index], 7, x, y, 2, color);
}

function drawSolarDot(x, y) {
	render.fillRectangle(theme.paper, x - 5, y - 5, 11, 11);
	render.fillRectangle(theme.ink, x - 3, y - 4, 7, 9);
	render.fillRectangle(theme.ink, x - 4, y - 3, 9, 7);
}

function solarRuler(now, w, phase) {
	const weather = state.weather;
	const night = phase && phase.night;
	const left = SOLAR_INSET;
	const right = w - SOLAR_INSET - 1;
	const offset = phase && phase.offset !== undefined ? phase.offset : weather ? weather.utcOffset : 0;
	return {
		left,
		right,
		night,
		x: phase ? left + Math.round((now - phase.start) / (phase.end - phase.start) * (right - left)) : null,
		startText: (night ? "SET " : "RISE ") + formatSolarTime(phase && phase.start, offset),
		endText: (night ? "RISE " : "SET ") + formatSolarTime(phase && phase.end, offset),
	};
}

// Bold Gothic digits touch at the HUD sizes, so "24" reads as one glyph;
// adjacent digits get a pixel of air.
const DIGIT_GAP = 1;

function isDigit(c) {
	return c >= "0" && c <= "9";
}

function trackedWidth(text, font) {
	let width = render.getTextWidth(text, font);
	for (let i = 1; i < text.length; i++) {
		if (isDigit(text[i - 1]) && isDigit(text[i]))
			width += DIGIT_GAP;
	}
	return width;
}

function drawTracked(text, font, color, x, y) {
	let start = 0;
	for (let i = 1; i <= text.length; i++) {
		if (i < text.length && !(isDigit(text[i - 1]) && isDigit(text[i])))
			continue;
		const part = text.slice(start, i);
		render.drawText(part, font, color, x, y);
		x += render.getTextWidth(part, font) + DIGIT_GAP;
		start = i;
	}
}

function drawSolarProgress(ruler, w) {
	const { left, right, x } = ruler;
	const y = RULER_Y;
	render.fillRectangle(theme.ink, left, y, right - left + 1, 1);
	render.fillRectangle(theme.ink, left, y - 3, 1, 7);
	render.fillRectangle(theme.ink, right, y - 3, 1, 7);
	if (x !== null)
		drawSolarDot(x, y);
	drawTracked(ruler.startText, smallFont, theme.ink, SOLAR_LABEL_INSET, SOLAR_LABEL_Y);
	drawTracked(ruler.endText, smallFont, theme.ink,
		w - SOLAR_LABEL_INSET - trackedWidth(ruler.endText, smallFont), SOLAR_LABEL_Y);
}

function drawSunMark(x, y) {
	render.fillRectangle(black, x - 4, y - 1, 9, 3);
	render.fillRectangle(black, x - 1, y - 4, 3, 9);
	render.fillRectangle(black, x - 3, y - 3, 1, 1);
	render.fillRectangle(black, x + 3, y - 3, 1, 1);
	render.fillRectangle(black, x - 3, y + 3, 1, 1);
	render.fillRectangle(black, x + 3, y + 3, 1, 1);
	render.fillRectangle(black, x - 2, y - 2, 1, 1);
	render.fillRectangle(black, x + 2, y - 2, 1, 1);
	render.fillRectangle(black, x - 2, y + 2, 1, 1);
	render.fillRectangle(black, x + 2, y + 2, 1, 1);
	render.fillRectangle(yellow, x - 3, y, 7, 1);
	render.fillRectangle(yellow, x, y - 3, 1, 7);
	render.fillRectangle(yellow, x - 1, y - 1, 3, 3);
	render.fillRectangle(yellow, x - 3, y - 3, 1, 1);
	render.fillRectangle(yellow, x + 3, y - 3, 1, 1);
	render.fillRectangle(yellow, x - 3, y + 3, 1, 1);
	render.fillRectangle(yellow, x + 3, y + 3, 1, 1);
	render.fillRectangle(yellow, x - 2, y - 2, 1, 1);
	render.fillRectangle(yellow, x + 2, y - 2, 1, 1);
	render.fillRectangle(yellow, x - 2, y + 2, 1, 1);
	render.fillRectangle(yellow, x + 2, y + 2, 1, 1);
}

function drawLocationPin(x, y) {
	render.fillRectangle(black, x - 2, y - 1, 5, 3);
	render.fillRectangle(black, x - 1, y - 2, 3, 5);
	render.fillRectangle(white, x - 1, y - 1, 3, 3);
}

// Bottom of the clock strip: the caption row starts below it.
const CLOCK_H = CAPTION_Y - MAP_H;
// What the HUD below the clock last showed; minutes that only move the clock
// push the clock strip instead of the whole HUD.
const hudDrawn = { caption: null, ruler: null };

function invalidateHud() {
	hudDrawn.caption = null;
}

function drawScreen(event) {
	const now = event?.date ?? lastDate;
	if (event?.date)
		lastDate = event.date;

	const w = render.unobstructed.width;
	const h = render.unobstructed.height;
	// A timeline quick view on the round screen covers where the clock sits; lift
	// the HUD over the bottom of the globe so the clock stays visible above it.
	const hudY = Math.min(MAP_H, h - CLOCK_H);
	// The caption and ruler keep their rows under a quick view, so clear down to
	// the screen's bottom, not the obstruction's top, or each redraw stacks on the last.
	const hudH = render.height - hudY;
	const origin = viewOrigin();
	const step = (now.getTime() / TERMINATOR_MS) | 0;
	const stars = litStarCount(now);
	const canShade = state.lat !== null || defaultGlobe;
	const globeDirty = canShade && (globeDrawn.lon !== origin.lon || globeDrawn.lat !== origin.lat
		|| globeDrawn.step !== step || globeDrawn.stars !== stars);

	const phase = solarPhaseFor(now);
	const ruler = solarRuler(now, w, phase);
	const mood = iconMood(now, phase);
	const moon = moonPhaseIndex(now);
	const dateStr = (DAYS[now.getDay()] + " " + MONTHS[now.getMonth()] + " " + now.getDate()).toUpperCase();
	const stale = state.status === "stale";
	const weatherStr = state.weather ? String(state.weather.temp) + "°" + (stale ? "!" : "") : "--°";
	const ink = stale || !state.weather ? theme.muted : theme.ink;
	const caption = w + "x" + h + " " + dateStr + " " + weatherStr + " " + ink + " " + mood + " " + moon;
	const rulerKey = ruler.x + " " + ruler.startText + " " + ruler.endText;
	let full = true;

	if (!canShade) {
		render.begin();
		render.fillRectangle(theme.sky, 0, 0, MAP_W, MAP_H);
	} else if (globeDirty) {
		render.begin();
		const sun = sunAt(now);
		drawMap(sun, origin);
		drawYearStars(now);
		const lat0 = origin.lat * Math.PI / 180;
		const sinLat0 = Math.sin(lat0);
		const cosLat0 = Math.cos(lat0);
		const lon0 = origin.lon * Math.PI / 180;
		const sunPip = projectGlobe(sun.lon, sun.lat, lon0, sinLat0, cosLat0);
		if (sunPip)
			drawSunMark(sunPip.x, sunPip.y);
		if (state.lat !== null) {
			const pin = projectGlobe(state.lon, state.lat, lon0, sinLat0, cosLat0);
			if (pin)
				drawLocationPin(pin.x, pin.y);
		}
		globeDrawn.lon = origin.lon;
		globeDrawn.lat = origin.lat;
		globeDrawn.step = step;
		globeDrawn.stars = stars;
	} else if (caption !== hudDrawn.caption || rulerKey !== hudDrawn.ruler)
		render.begin(0, hudY, w, hudH);
	else {
		render.begin(0, hudY, w, CLOCK_H);
		full = false;
	}

	render.fillRectangle(theme.paper, 0, hudY, w, full ? hudH : CLOCK_H);

	const timeStr = formatTime(now);
	const period = watch.hour12 ? (now.getHours() < 12 ? "AM" : "PM") : "";
	const timeW = render.getTextWidth(timeStr, timeFont);
	const timeX = ((w - timeW) / 2) | 0;
	render.drawText(timeStr, timeFont, theme.ink, timeX, hudY);
	if (period)
		render.drawText(period, smallFont, theme.muted, timeX + timeW + 5, hudY + 26);

	if (full) {
		drawTracked(dateStr, dateFont, theme.ink, CAPTION_INSET, CAPTION_Y);
		drawMoonPhase(moon, CAPTION_INSET + trackedWidth(dateStr, dateFont) + 8, CAPTION_Y + 3, theme.ink);
		const weatherX = w - CAPTION_INSET - trackedWidth(weatherStr, dateFont);
		drawTracked(weatherStr, dateFont, ink, weatherX, CAPTION_Y);
		drawWeatherIcon(mood, weatherX - 22, CAPTION_Y + 3, ink);
		drawSolarProgress(ruler, w);
		hudDrawn.caption = caption;
		hudDrawn.ruler = rulerKey;
	}

	render.end();
}

function weatherDate(seconds) {
	if (!Number.isFinite(seconds) || seconds <= 0)
		return null;
	const date = new Date(seconds * 1000);
	return Number.isFinite(date.getTime()) ? date : null;
}

function wireNumber(field) {
	return field === undefined || field === "" ? NaN : Number(field);
}

// Fields from the phone's CSV payload: lat,lon,updatedAt,temp,code,utcOffset,
// then day,sunrise,sunset triples in Unix seconds.
function parseWeather(fields) {
	const temp = wireNumber(fields[3]);
	const code = wireNumber(fields[4]);
	const codes = [0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99];
	if (!Number.isFinite(temp) || codes.indexOf(code) < 0)
		return null;
	// Unix timestamps remain UTC; only calendar-day matching uses the location offset.
	const utcOffset = wireNumber(fields[5]);
	const offset = Number.isFinite(utcOffset) ? utcOffset : 0;
	const today = Math.floor((Date.now() / 1000 + offset) / 86400);
	const solarDays = [];
	for (let i = 6; i < fields.length && solarDays.length < 4; i += 3) {
		const time = wireNumber(fields[i]);
		if (!Number.isFinite(time))
			continue;
		const stamp = Math.floor((time + offset) / 86400);
		// Retain yesterday's sunset for a fresh launch or refresh before dawn.
		if (stamp < today - 1)
			continue;
		solarDays.push({
			day: stamp,
			sunrise: weatherDate(wireNumber(fields[i + 1])),
			sunset: weatherDate(wireNumber(fields[i + 2])),
		});
	}
	return {
		// Already in the unit chosen in the phone settings.
		temp: Math.round(temp),
		code,
		utcOffset: offset,
		solarDays,
	};
}

function validCoordinates(lat, lon) {
	return Number.isFinite(lat) && Math.abs(lat) <= 90 && Number.isFinite(lon) && Math.abs(lon) <= 180;
}

function weatherFailed() {
	if (!state.weather)
		state.status = "offline";
	else if (Date.now() - state.updatedAt >= 7200000)
		state.status = "stale";
	if (state.lat === null)
		defaultGlobe = true;
	drawScreen();
}

function applyPayload(text) {
	const fields = String(text).split(",");
	if (fields.length < 2) {
		weatherFailed();
		return;
	}
	const lat = wireNumber(fields[0]);
	const lon = wireNumber(fields[1]);
	if (!validCoordinates(lat, lon)) {
		weatherFailed();
		return;
	}
	state.lat = lat;
	state.lon = lon;
	const parsed = parseWeather(fields);
	if (!parsed) {
		drawScreen();
		weatherFailed();
		return;
	}
	state.weather = parsed;
	const fetchedAt = wireNumber(fields[2]);
	state.updatedAt = Number.isFinite(fetchedAt) && fetchedAt > 0 ? fetchedAt : Date.now();
	state.status = Date.now() - state.updatedAt >= 7200000 ? "stale" : "ready";
	drawScreen();
	storePayload(text);
}

// The last good payload survives relaunches, so returning to the face does not
// wait on the phone. Storage can be missing (tests) or fail; both are harmless.
const STORE_KEY = "wx";
let storedPayload = null;

function storePayload(text) {
	if (text === storedPayload)
		return;
	storedPayload = text;
	try {
		localStorage.setItem(STORE_KEY, text);
	} catch (e) {
	}
}

function restorePayload() {
	if (state.lat !== null)
		return;
	try {
		storedPayload = localStorage.getItem(STORE_KEY);
	} catch (e) {
		return;
	}
	if (storedPayload)
		applyPayload(storedPayload);
}

// The theme is kept on the watch too, so a relaunch paints in it before the
// phone connects.
const THEME_KEY = "th";

function applyTheme(index, stored) {
	const next = THEMES[index];
	if (!next || next === theme)
		return;
	theme = next;
	globeDrawn.step = -1;
	invalidateHud();
	if (stored)
		return;
	drawScreen();
	try {
		localStorage.setItem(THEME_KEY, String(index));
	} catch (e) {
	}
}

function restoreTheme() {
	try {
		applyTheme(Number(localStorage.getItem(THEME_KEY)), true);
	} catch (e) {
	}
}

function requestRefresh() {
	if (!phoneWritable)
		return;
	try {
		phone.write(new Map([["CMD", 1]]));
	} catch (e) {
		console.log("refresh " + e);
	}
}

watch.addEventListener("minutechange", event => {
	if (state.weather && Date.now() - state.updatedAt >= 7200000)
		state.status = "stale";
	drawScreen(event);
});
watch.addEventListener("resize", event => {
	globeDrawn.step = -1;
	invalidateHud();
	drawScreen(event);
});
watch.addEventListener("hourchange", requestRefresh);
restoreTheme();
drawScreen();
setTimeout(restorePayload, 0);
setTimeout(() => {
	if (state.lat === null) {
		defaultGlobe = true;
		drawScreen();
	}
}, 2000);
setTimeout(() => {
	if (state.lat === null)
		weatherFailed();
}, 30000);
