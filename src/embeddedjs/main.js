import Poco from "commodetto/Poco";
import Message from "pebble/message";
import { MASK, MASK_W, MASK_H } from "worldmask";
import { STAR_N, STAR_X, STAR_Y, STAR_SHAPE, litStarCount, isSeasonStar } from "yearstars";

const MAP_W = 200;
const MAP_H = 132;

const render = new Poco(screen);
const timeFont = new render.Font("Bitham-Bold", 42);
const dateFont = new render.Font("Gothic-Bold", 18);
const smallFont = new render.Font("Gothic-Bold", 14);

const black = render.makeColor(0, 0, 0);
const white = render.makeColor(255, 255, 255);
const yellow = render.makeColor(255, 255, 0);
const cyan = render.makeColor(0, 255, 255);
const hudMuted = render.makeColor(85, 85, 85);
const dayOcean = render.makeColor(0, 0, 255);
const nightOcean = render.makeColor(0, 0, 85);
const dayLand = render.makeColor(0, 255, 0);
const nightLand = render.makeColor(0, 85, 0);

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
	keys: ["PAYLOAD", "CMD"],
	input: 1024,
	output: 256,
	onReadable() {
		const msg = this.read();
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
	// NOAA fractional-year approximation, using UTC rather than local time.
	const year = now.getUTCFullYear();
	const days = (Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / 86400000;
	const day = (now.getTime() - Date.UTC(year, 0, 1)) / 86400000;
	const gamma = 2 * Math.PI * (day - 0.5) / days;
	const equation = 229.18 * (0.000075 + 0.001868 * Math.cos(gamma)
		- 0.032077 * Math.sin(gamma) - 0.014615 * Math.cos(2 * gamma)
		- 0.040849 * Math.sin(2 * gamma));
	const declination = 0.006918 - 0.399912 * Math.cos(gamma)
		+ 0.070257 * Math.sin(gamma) - 0.006758 * Math.cos(2 * gamma)
		+ 0.000907 * Math.sin(2 * gamma) - 0.002697 * Math.cos(3 * gamma)
		+ 0.00148 * Math.sin(3 * gamma);
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

const GLOBE_CX = MAP_W / 2;
const GLOBE_CY = MAP_H / 2;
const GLOBE_R = 64;
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
	const i = y * MASK_W + x;
	return (MASK[i >> 3] >> (i & 7)) & 1;
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

// One land bit per 2x2 globe sample. Land depends only on the view origin, so the
// asin/atan2 inverse projection runs on relocation, not on every terminator step.
const SAMPLE_W = MAP_W >> 1;
const landBits = new Uint8Array((SAMPLE_W * (MAP_H >> 1) + 7) >> 3);
const landFor = { lon: 9999, lat: 9999 };

function cacheLand(origin, lon0, sinLat0, cosLat0) {
	landBits.fill(0);
	for (let y = 0; y < MAP_H; y += 2) {
		const yn = (GLOBE_CY - (y + 1)) / GLOBE_R;
		for (let x = 0; x < MAP_W; x += 2) {
			const xn = (x + 1 - GLOBE_CX) / GLOBE_R;
			const rr = xn * xn + yn * yn;
			if (rr > 1)
				continue;
			const z = Math.sqrt(1 - rr);
			const lat = Math.asin(Math.max(-1, Math.min(1, yn * cosLat0 + z * sinLat0))) * 180 / Math.PI;
			let lon = (lon0 + Math.atan2(xn, z * cosLat0 - yn * sinLat0)) * 180 / Math.PI;
			lon = ((lon + 180) % 360 + 360) % 360 - 180;
			if (isLand(lon, lat)) {
				const i = (y >> 1) * SAMPLE_W + (x >> 1);
				landBits[i >> 3] |= 1 << (i & 7);
			}
		}
	}
	landFor.lon = origin.lon;
	landFor.lat = origin.lat;
}

function drawMap(sun, origin) {
	const lon0 = origin.lon * Math.PI / 180;
	const lat0 = origin.lat * Math.PI / 180;
	const sinLat0 = Math.sin(lat0);
	const cosLat0 = Math.cos(lat0);
	const sinLon0 = Math.sin(lon0);
	const cosLon0 = Math.cos(lon0);
	if (landFor.lon !== origin.lon || landFor.lat !== origin.lat)
		cacheLand(origin, lon0, sinLat0, cosLat0);
	// isNightLonLat as a dot product: the sun's direction rotated into the globe's
	// view frame, so each sample needs no trig to find its side of the terminator.
	const sunX = -sun.cosY * sun.cosX;
	const sunY = -sun.cosY * sun.sinX;
	const sunZ = -sun.sinY;
	const a = sunX * cosLon0 + sunY * sinLon0;
	const vx = sunY * cosLon0 - sunX * sinLon0;
	const vy = sunZ * cosLat0 - a * sinLat0;
	const vz = a * cosLat0 + sunZ * sinLat0;
	render.fillRectangle(black, 0, 0, MAP_W, MAP_H);
	for (let y = 0; y < MAP_H; y += 2) {
		let runX = 0;
		let runColor = -1;
		const yn = (GLOBE_CY - (y + 1)) / GLOBE_R;
		const row = (y >> 1) * SAMPLE_W;
		for (let x = 0; x <= MAP_W; x += 2) {
			let color = -1;
			if (x < MAP_W) {
				const xn = (x + 1 - GLOBE_CX) / GLOBE_R;
				const rr = xn * xn + yn * yn;
				if (rr <= 1) {
					const i = row + (x >> 1);
					const land = (landBits[i >> 3] >> (i & 7)) & 1;
					const night = vx * xn + vy * yn + vz * Math.sqrt(1 - rr) < NIGHT_SIN;
					color = (land ? 2 : 0) + (night ? 1 : 0);
				}
			}
			if (color === runColor)
				continue;
			if (runColor >= 0)
				render.fillRectangle(GLOBE_COLORS[runColor], runX, y, x - runX, 2);
			runX = x;
			runColor = color;
		}
	}
}

function drawYearStars(now) {
	const n = litStarCount(now);
	const year = now.getFullYear();
	for (let i = 0; i < STAR_N; i++) {
		const season = isSeasonStar(i, year);
		if (i >= n && !season)
			continue;
		const color = season ? cyan : white;
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

function formatSolarTime(date, offset) {
	if (!date)
		return "--:--";
	const local = new Date(date.getTime() + offset * 1000);
	const hours = local.getUTCHours();
	if (watch.hour12)
		return (hours % 12 || 12) + ":" + pad2(local.getUTCMinutes()) + (hours < 12 ? "a" : "p");
	return pad2(hours) + ":" + pad2(local.getUTCMinutes());
}

function solarPhaseFor(now) {
	const weather = state.weather;
	if (!weather)
		return null;
	const days = weather.solarDays;
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
	render.fillRectangle(white, x - 5, y - 5, 11, 11);
	render.fillRectangle(black, x - 3, y - 4, 7, 9);
	render.fillRectangle(black, x - 4, y - 3, 9, 7);
}

// The bottom row stays clear of the rounded screen corners the appstore's
// Time 2 frame draws over screenshots.
const CAPTION_Y = 174;
const RULER_Y = 200;
const SOLAR_LABEL_Y = 205;
const SOLAR_INSET = 16;

function solarRuler(now, w, phase) {
	const weather = state.weather;
	const night = phase && phase.night;
	const left = SOLAR_INSET;
	const right = w - SOLAR_INSET - 1;
	const offset = weather ? weather.utcOffset : 0;
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
	render.fillRectangle(black, left, y, right - left + 1, 1);
	render.fillRectangle(black, left, y - 3, 1, 7);
	render.fillRectangle(black, right, y - 3, 1, 7);
	if (x !== null)
		drawSolarDot(x, y);
	drawTracked(ruler.startText, smallFont, black, SOLAR_INSET, SOLAR_LABEL_Y);
	drawTracked(ruler.endText, smallFont, black,
		w - SOLAR_INSET - trackedWidth(ruler.endText, smallFont), SOLAR_LABEL_Y);
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
	const hudY = MAP_H;
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
	const ink = stale || !state.weather ? hudMuted : black;
	const caption = w + "x" + h + " " + dateStr + " " + weatherStr + " " + ink + " " + mood + " " + moon;
	const rulerKey = ruler.x + " " + ruler.startText + " " + ruler.endText;
	let full = true;

	if (!canShade) {
		render.begin();
		render.fillRectangle(black, 0, 0, MAP_W, MAP_H);
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
		render.begin(0, hudY, w, h - hudY);
	else {
		render.begin(0, hudY, w, CLOCK_H);
		full = false;
	}

	render.fillRectangle(white, 0, hudY, w, full ? h - hudY : CLOCK_H);

	const timeStr = formatTime(now);
	const period = watch.hour12 ? (now.getHours() < 12 ? "AM" : "PM") : "";
	const timeW = render.getTextWidth(timeStr, timeFont);
	const timeX = ((w - timeW) / 2) | 0;
	render.drawText(timeStr, timeFont, black, timeX, hudY);
	if (period)
		render.drawText(period, smallFont, hudMuted, timeX + timeW + 5, hudY + 26);

	if (full) {
		drawTracked(dateStr, dateFont, black, 9, CAPTION_Y);
		drawMoonPhase(moon, 9 + trackedWidth(dateStr, dateFont) + 8, CAPTION_Y + 3, black);
		const weatherX = w - 9 - trackedWidth(weatherStr, dateFont);
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
