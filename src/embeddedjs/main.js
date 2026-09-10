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
const nightBlue = render.makeColor(0, 0, 255);
const dayFill = render.makeColor(255, 170, 0);
const dayOcean = render.makeColor(0, 85, 255);
const nightOcean = render.makeColor(0, 0, 170);
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
const phone = new Message({
	keys: ["PAYLOAD", "CMD"],
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

function isNightXY(x, sinY, cosY, sun) {
	const xA = Math.PI * 2 * x / MAP_W;
	return sun.sinY * sinY + sun.cosY * cosY * (sun.cosX * Math.cos(xA) + sun.sinX * Math.sin(xA)) < NIGHT_SIN;
}

function nightSpansAt(y, sun) {
	const yA = Math.PI * y / MAP_H - Math.PI / 2;
	const sinY = Math.sin(yA);
	const cosY = Math.cos(yA);
	const spans = [];
	let x0 = -1;
	for (let x = 0; x <= MAP_W; x++) {
		const night = x < MAP_W && isNightXY(x, sinY, cosY, sun);
		if (night && x0 < 0)
			x0 = x;
		else if (!night && x0 >= 0) {
			spans.push(x0, x);
			x0 = -1;
		}
	}
	return spans;
}

const GLOBE_CX = MAP_W / 2;
const GLOBE_CY = MAP_H / 2;
const GLOBE_R = 64;
const GLOBE_TILT_MAX = 40;

function isNightLonLat(lon, lat, sun) {
	const xA = (lon + 180) * Math.PI / 180;
	const latR = lat * Math.PI / 180;
	return sun.sinY * Math.sin(-latR) + sun.cosY * Math.cos(latR) * (sun.cosX * Math.cos(xA) + sun.sinX * Math.sin(xA)) < NIGHT_SIN;
}

function unprojectGlobe(x, y, lon0, sinLat0, cosLat0) {
	const xn = (x + 0.5 - GLOBE_CX) / GLOBE_R;
	const yn = (GLOBE_CY - (y + 0.5)) / GLOBE_R;
	const rr = xn * xn + yn * yn;
	if (rr > 1)
		return null;
	const z = Math.sqrt(1 - rr);
	const lat = Math.asin(Math.max(-1, Math.min(1, yn * cosLat0 + z * sinLat0)));
	let lon = (lon0 + Math.atan2(xn, z * cosLat0 - yn * sinLat0)) * 180 / Math.PI;
	lon = ((lon + 180) % 360 + 360) % 360 - 180;
	return { lon, lat: lat * 180 / Math.PI };
}

function globeNightSpansAt(y, sun, lon0, sinLat0, cosLat0) {
	const spans = [];
	let x0 = -1;
	for (let x = 0; x <= MAP_W; x++) {
		const p = x < MAP_W ? unprojectGlobe(x, y, lon0, sinLat0, cosLat0) : null;
		const night = !!(p && isNightLonLat(p.lon, p.lat, sun));
		if (night && x0 < 0)
			x0 = x;
		else if (!night && x0 >= 0) {
			spans.push(x0, x);
			x0 = -1;
		}
	}
	return spans;
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

function drawMap(sun) {
	const origin = viewOrigin();
	const lon0 = origin.lon * Math.PI / 180;
	const lat0 = origin.lat * Math.PI / 180;
	const sinLat0 = Math.sin(lat0);
	const cosLat0 = Math.cos(lat0);
	const colors = [dayOcean, nightOcean, dayLand, nightLand];
	render.fillRectangle(black, 0, 0, MAP_W, MAP_H);
	for (let y = 0; y < MAP_H; y += 2) {
		let runX = 0;
		let runColor = -1;
		const yn = (GLOBE_CY - (y + 1)) / GLOBE_R;
		for (let x = 0; x <= MAP_W; x += 2) {
			let color = -1;
			if (x < MAP_W) {
				const xn = (x + 1 - GLOBE_CX) / GLOBE_R;
				const rr = xn * xn + yn * yn;
				if (rr <= 1) {
					const z = Math.sqrt(1 - rr);
					const lat = Math.asin(Math.max(-1, Math.min(1, yn * cosLat0 + z * sinLat0))) * 180 / Math.PI;
					let lon = (lon0 + Math.atan2(xn, z * cosLat0 - yn * sinLat0)) * 180 / Math.PI;
					lon = ((lon + 180) % 360 + 360) % 360 - 180;
					color = (isLand(lon, lat) ? 2 : 0) + (isNightLonLat(lon, lat, sun) ? 1 : 0);
				}
			}
			if (color === runColor)
				continue;
			if (runColor >= 0)
				render.fillRectangle(colors[runColor], runX, y, x - runX, 2);
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
		render.fillRectangle(color, x, y, 1, 1);
		if (shape === 1)
			render.fillRectangle(color, x + 1, y, 1, 1);
		else if (shape >= 2) {
			render.fillRectangle(color, x - 1, y, 1, 1);
			render.fillRectangle(color, x + 1, y, 1, 1);
			render.fillRectangle(color, x, y - 1, 1, 1);
			render.fillRectangle(color, x, y + 1, 1, 1);
			if (shape === 3) {
				render.fillRectangle(color, x - 1, y - 1, 1, 1);
				render.fillRectangle(color, x + 1, y - 1, 1, 1);
				render.fillRectangle(color, x - 1, y + 1, 1, 1);
				render.fillRectangle(color, x + 1, y + 1, 1, 1);
			}
		}
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

function drawWeatherIcon(now, x, y, color) {
	if (!state.weather)
		return;
	let mood = moodFor(state.weather.code);
	if (mood === "DRIZL" || mood === "SHWR")
		mood = "RAIN";
	if (mood === "CLEAR" && isNightLonLat(state.lon, state.lat, sunAt(now)))
		mood = "MOON";
	const rows = WEATHER_ICONS[mood];
	for (let row = 0; row < rows.length; row++) {
		for (let col = 0; col < 16; col++) {
			if (rows[row] & (0x8000 >> col))
				render.fillRectangle(color, x + col, y + row, 1, 1);
		}
	}
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
	const jd = now.getTime() / 86400000 + 2440587.5;
	let phase = (jd - 2451550.1) / 29.530588853;
	phase -= Math.floor(phase);
	return Math.round(phase * 8) % 8;
}

function drawMoonPhase(now, x, y, color) {
	const rows = MOON_PHASES[moonPhaseIndex(now)];
	for (let row = 0; row < rows.length; row++) {
		for (let col = 0; col < 7; col++) {
			if (rows[row] & (0x40 >> col))
				render.fillRectangle(color, x + col * 2, y + row * 2, 2, 2);
		}
	}
}

function drawSolarDot(x, y) {
	render.fillRectangle(white, x - 5, y - 5, 11, 11);
	render.fillRectangle(black, x - 3, y - 4, 7, 9);
	render.fillRectangle(black, x - 4, y - 3, 9, 7);
}

function drawSolarProgress(now, w) {
	const weather = state.weather;
	const phase = solarPhaseFor(now);
	const night = phase && phase.night;
	const left = 13;
	const right = w - 14;
	const y = 205;
	render.fillRectangle(black, left, y, right - left + 1, 1);
	render.fillRectangle(black, left, y - 3, 1, 7);
	render.fillRectangle(black, right, y - 3, 1, 7);
	if (phase) {
		const progress = (now - phase.start) / (phase.end - phase.start);
		const x = left + Math.round(progress * (right - left));
		render.fillRectangle(night ? nightBlue : dayFill, left, y, x - left, 1);
		drawSolarDot(x, y);
	}
	const offset = weather ? weather.utcOffset : 0;
	const startText = (night ? "SET " : "RISE ") + formatSolarTime(phase && phase.start, offset);
	const endText = (night ? "RISE " : "SET ") + formatSolarTime(phase && phase.end, offset);
	render.drawText(startText, smallFont, black, 9, 210);
	render.drawText(endText, smallFont, black,
		w - 9 - render.getTextWidth(endText, smallFont), 210);
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
	const globeDirty = globeDrawn.lon !== origin.lon || globeDrawn.lat !== origin.lat
		|| globeDrawn.step !== step || globeDrawn.stars !== stars;

	if (globeDirty) {
		render.begin();
		const sun = sunAt(now);
		drawMap(sun);
		drawYearStars(now);
		const lat0 = origin.lat * Math.PI / 180;
		const sinLat0 = Math.sin(lat0);
		const cosLat0 = Math.cos(lat0);
		const lon0 = origin.lon * Math.PI / 180;
		const sunPip = projectGlobe(sun.lon, sun.lat, lon0, sinLat0, cosLat0);
		if (sunPip) {
			render.fillRectangle(black, sunPip.x - 2, sunPip.y - 1, 5, 3);
			render.fillRectangle(black, sunPip.x - 1, sunPip.y - 2, 3, 5);
			render.fillRectangle(yellow, sunPip.x - 1, sunPip.y, 3, 1);
			render.fillRectangle(yellow, sunPip.x, sunPip.y - 1, 1, 3);
		}
		if (state.lat !== null) {
			const pin = projectGlobe(state.lon, state.lat, lon0, sinLat0, cosLat0);
			if (pin) {
				render.fillRectangle(black, pin.x - 2, pin.y - 2, 5, 5);
				render.fillRectangle(yellow, pin.x - 1, pin.y - 1, 3, 3);
			}
		}
		globeDrawn.lon = origin.lon;
		globeDrawn.lat = origin.lat;
		globeDrawn.step = step;
		globeDrawn.stars = stars;
	} else
		render.begin(0, hudY, w, h - hudY);

	render.fillRectangle(white, 0, hudY, w, h - hudY);

	const timeStr = formatTime(now);
	const period = watch.hour12 ? (now.getHours() < 12 ? "AM" : "PM") : "";
	const timeW = render.getTextWidth(timeStr, timeFont);
	const timeX = ((w - timeW) / 2) | 0;
	render.drawText(timeStr, timeFont, black, timeX, hudY);
	if (period)
		render.drawText(period, smallFont, hudMuted, timeX + timeW + 5, hudY + 26);

	const dateStr = (DAYS[now.getDay()] + " " + MONTHS[now.getMonth()] + " " + now.getDate()).toUpperCase();
	const stale = state.status === "stale";
	const weatherStr = state.weather ? String(state.weather.tempF) + "°" + (stale ? "!" : "") : "--°";
	const ink = stale || !state.weather ? hudMuted : black;
	render.drawText(dateStr, dateFont, black, 9, 178);
	drawMoonPhase(now, 9 + render.getTextWidth(dateStr, dateFont) + 8, 181, black);
	const weatherX = w - 9 - render.getTextWidth(weatherStr, dateFont);
	render.drawText(weatherStr, dateFont, ink, weatherX, 178);
	drawWeatherIcon(now, weatherX - 22, 181, ink);
	drawSolarProgress(now, w);

	render.end();
}

function weatherDate(seconds) {
	if (!Number.isFinite(seconds) || seconds <= 0)
		return null;
	const date = new Date(seconds * 1000);
	return Number.isFinite(date.getTime()) ? date : null;
}

function validTempF(t) {
	return Number.isFinite(t) && t >= -80 && t <= 140;
}

function parseWeather(data) {
	const current = data && data.current;
	const codes = [0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99];
	if (!current || !Number.isFinite(current.temperature_2m) || codes.indexOf(current.weather_code) < 0)
		return null;
	const daily = data.daily;
	// Unix timestamps remain UTC; only calendar-day matching uses the location offset.
	const offset = Number.isFinite(data.utc_offset_seconds) ? data.utc_offset_seconds : 0;
	const today = Math.floor((Date.now() / 1000 + offset) / 86400);
	let day = -1;
	const days = [];
	const solarDays = [];
	if (daily && Array.isArray(daily.time)) {
		for (let i = 0; i < daily.time.length; i++) {
			if (!Number.isFinite(daily.time[i]))
				continue;
			const stamp = Math.floor((daily.time[i] + offset) / 86400);
			if (day < 0 && stamp === today)
				day = i;
			// Retain yesterday's sunset for a fresh launch or refresh before dawn.
			if (stamp < today - 1)
				continue;
			if (solarDays.length < 8) {
				solarDays.push({
					day: stamp,
					sunrise: Array.isArray(daily.sunrise) ? weatherDate(daily.sunrise[i]) : null,
					sunset: Array.isArray(daily.sunset) ? weatherDate(daily.sunset[i]) : null,
				});
			}
			if (stamp < today || days.length >= 7)
				continue;
			const hi = daily.temperature_2m_max && daily.temperature_2m_max[i];
			const lo = daily.temperature_2m_min && daily.temperature_2m_min[i];
			if (!validTempF(hi) || !validTempF(lo) || hi < lo)
				continue;
			days.push({ hi, lo });
		}
	}
	return {
		tempF: Math.round(current.temperature_2m),
		code: current.weather_code,
		utcOffset: offset,
		solarDays,
		days,
		sunrise: day >= 0 && Array.isArray(daily.sunrise) ? weatherDate(daily.sunrise[day]) : null,
		sunset: day >= 0 && Array.isArray(daily.sunset) ? weatherDate(daily.sunset[day]) : null,
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
	drawScreen();
}

function applyPayload(text) {
	let data;
	try {
		data = JSON.parse(text);
	} catch (e) {
		console.log("payload json " + e);
		weatherFailed();
		return;
	}
	if (!data || data.error) {
		weatherFailed();
		return;
	}
	const lat = Number(data.lat);
	const lon = Number(data.lon);
	if (!validCoordinates(lat, lon)) {
		weatherFailed();
		return;
	}
	state.lat = lat;
	state.lon = lon;
	const parsed = parseWeather(data.weather);
	if (!parsed) {
		drawScreen();
		weatherFailed();
		return;
	}
	state.weather = parsed;
	state.updatedAt = Date.now();
	state.status = "ready";
	drawScreen();
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
	drawScreen(event);
});
watch.addEventListener("hourchange", requestRefresh);
drawScreen();
setTimeout(() => {
	if (state.lat === null)
		weatherFailed();
}, 30000);
