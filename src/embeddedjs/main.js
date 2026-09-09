import Poco from "commodetto/Poco";
import Location from "embedded:sensor/Location";

const MAP_W = 200;
const MAP_H = 100;

const render = new Poco(screen);
const timeFont = new render.Font("Leco-Regular", 42);
const dateFont = new render.Font("Gothic-Bold", 18);
const smallFont = new render.Font("Gothic-Regular", 14);

const black = render.makeColor(0, 0, 0);
const white = render.makeColor(255, 255, 255);
const gray = render.makeColor(170, 170, 170);
const yellow = render.makeColor(255, 255, 0);
const barFill = render.makeColor(0, 170, 255);
const dayOcean = render.makeColor(0, 85, 170);
const nightOcean = render.makeColor(0, 0, 85);

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
let locationSensor = null;
let dayMap = null;
let nightMap = null;

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
	};
}

function isNightXY(x, sinY, cosY, sun) {
	const xA = Math.PI * 2 * x / MAP_W;
	return sun.sinY * sinY + sun.cosY * cosY * (sun.cosX * Math.cos(xA) + sun.sinX * Math.sin(xA)) < 0;
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

function ensureMaps() {
	if (dayMap)
		return true;
	try {
		dayMap = new Poco.PebbleBitmap(1);
		nightMap = new Poco.PebbleBitmap(2);
		return true;
	} catch (e) {
		console.log("Map bitmap error: " + e);
		dayMap = null;
		nightMap = null;
		return false;
	}
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

function drawMap(sun) {
	if (ensureMaps()) {
		render.drawBitmap(dayMap, 0, 0);
		const band = 5;
		for (let y = 0; y < MAP_H; y += band) {
			const h = y + band > MAP_H ? MAP_H - y : band;
			const spans = nightSpansAt(y + (h >> 1), sun);
			for (let i = 0; i < spans.length; i += 2) {
				const x = spans[i];
				const w = spans[i + 1] - x;
				if (w > 0)
					render.drawBitmap(nightMap, x, y, x, y, w, h);
			}
		}
		return;
	}

	render.fillRectangle(dayOcean, 0, 0, MAP_W, MAP_H);
	const spans = nightSpansAt(MAP_H >> 1, sun);
	for (let i = 0; i < spans.length; i += 2)
		render.fillRectangle(nightOcean, spans[i], 0, spans[i + 1] - spans[i], MAP_H);
}

function drawScreen(event) {
	const now = event?.date ?? lastDate;
	if (event?.date)
		lastDate = event.date;

	const w = render.unobstructed.width;
	const h = render.unobstructed.height;
	const hudY = MAP_H;

	render.begin();
	drawMap(sunAt(now));

	if (state.lat !== null) {
		const px = (((state.lon + 180) / 360) * MAP_W) | 0;
		const py = (((90 - state.lat) / 180) * MAP_H) | 0;
		render.fillRectangle(black, px - 2, py - 2, 5, 5);
		render.fillRectangle(yellow, px - 1, py - 1, 3, 3);
	}

	render.fillRectangle(black, 0, hudY, w, h - hudY);
	render.fillRectangle(white, 0, hudY, w, 1);

	let sparkH = 0;
	const hours = state.weather && state.weather.hours;
	if (hours && hours.length > 1) {
		let maxP = 0;
		for (let i = 0; i < hours.length; i++) {
			if (hours[i].precip > maxP)
				maxP = hours[i].precip;
		}
		if (maxP >= 15) {
			const base = hudY + 12;
			const left = 16;
			const span = w - 32;
			let px = left;
			let py = base - ((hours[0].precip * 8 / 100) | 0);
			for (let i = 1; i < hours.length; i++) {
				const nx = left + ((i * span / (hours.length - 1)) | 0);
				const ny = base - ((hours[i].precip * 8 / 100) | 0);
				render.drawLine(px, py, nx, ny, barFill, 2);
				px = nx;
				py = ny;
			}
			sparkH = 10;
		}
	}

	const timeStr = formatTime(now);
	const timeY = hudY + 6 + sparkH;
	render.drawText(timeStr, timeFont, white,
		((w - render.getTextWidth(timeStr, timeFont)) / 2) | 0, timeY);

	const dateStr = DAYS[now.getDay()] + ", " + MONTHS[now.getMonth()] + " " + now.getDate();
	const dateY = timeY + 40;
	render.drawText(dateStr, dateFont, white,
		((w - render.getTextWidth(dateStr, dateFont)) / 2) | 0, dateY);

	let weatherStr = "--C  WAIT";
	if (state.status === "offline" && !state.weather)
		weatherStr = state.lat === null ? "--C  NO LOC" : "--C  OFFLINE";
	else if (state.weather)
		weatherStr = String(state.weather.tempC) + "C  " + (state.status === "stale" ? "STALE" : moodFor(state.weather.code));
	const weatherY = dateY + 20;
	render.drawText(weatherStr, dateFont, white,
		((w - render.getTextWidth(weatherStr, dateFont)) / 2) | 0, weatherY);

	const rise = state.weather && state.weather.sunrise
		? pad2(state.weather.sunrise.getHours()) + ":" + pad2(state.weather.sunrise.getMinutes())
		: "--:--";
	const set = state.weather && state.weather.sunset
		? pad2(state.weather.sunset.getHours()) + ":" + pad2(state.weather.sunset.getMinutes())
		: "--:--";
	const sunY = weatherY + 22;
	render.drawText(rise, smallFont, gray, 8, sunY);
	render.drawText(set, smallFont, gray, w - 8 - render.getTextWidth(set, smallFont), sunY);

	render.end();
}

function weatherDate(seconds) {
	if (!Number.isFinite(seconds) || seconds <= 0)
		return null;
	const date = new Date(seconds * 1000);
	return Number.isFinite(date.getTime()) ? date : null;
}

function parseWeather(data) {
	const current = data && data.current;
	const codes = [0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99];
	if (!current || !Number.isFinite(current.temperature_2m) || codes.indexOf(current.weather_code) < 0)
		return null;
	const hours = [];
	const hourly = data.hourly;
	if (hourly && Array.isArray(hourly.time) && Array.isArray(hourly.precipitation_probability)) {
		const nowMs = Date.now();
		for (let i = 0; i < hourly.time.length && hours.length < 6; i++) {
			const stamp = weatherDate(hourly.time[i]);
			const precip = hourly.precipitation_probability[i];
			// Precipitation timestamps mark the end of the preceding hour.
			if (!stamp || stamp.getTime() <= nowMs || !Number.isFinite(precip) || precip < 0 || precip > 100)
				continue;
			hours.push({ precip });
		}
	}
	const daily = data.daily;
	// Unix timestamps remain UTC; only calendar-day matching uses the location offset.
	const offset = Number.isFinite(data.utc_offset_seconds) ? data.utc_offset_seconds : 0;
	const today = Math.floor((Date.now() / 1000 + offset) / 86400);
	let day = -1;
	if (daily && Array.isArray(daily.time)) {
		for (let i = 0; i < daily.time.length; i++) {
			if (Number.isFinite(daily.time[i]) && Math.floor((daily.time[i] + offset) / 86400) === today) {
				day = i;
				break;
			}
		}
	}
	return {
		tempC: Math.round(current.temperature_2m),
		code: current.weather_code,
		hours,
		sunrise: day >= 0 && Array.isArray(daily.sunrise) ? weatherDate(daily.sunrise[day]) : null,
		sunset: day >= 0 && Array.isArray(daily.sunset) ? weatherDate(daily.sunset[day]) : null,
	};
}

const WEATHER_TIMEOUT = 20000;
const WEATHER_RETRY_DELAY = 10000;
let locationGeneration = 0;
let locationTimer = null;

function validCoordinates(lat, lon) {
	return Number.isFinite(lat) && Math.abs(lat) <= 90 && Number.isFinite(lon) && Math.abs(lon) <= 180;
}

function weatherFailed() {
	state.status = state.weather ? "stale" : "offline";
	drawScreen();
}

function closeLocation() {
	clearTimeout(locationTimer);
	locationTimer = null;
	try { locationSensor?.close(); } catch (_) {}
	locationSensor = null;
}

function requestLocation(allowRetry = true) {
	const generation = ++locationGeneration;
	closeLocation();
	let settled = false;
	const fail = () => {
		if (settled || generation !== locationGeneration)
			return;
		settled = true;
		closeLocation();
		weatherFailed();
		if (allowRetry)
			locationTimer = setTimeout(() => {
				if (generation === locationGeneration)
					requestLocation(false);
			}, WEATHER_RETRY_DELAY);
	};
	try {
		locationSensor = new Location({
			onSample() {
				if (settled || generation !== locationGeneration)
					return;
				try {
					const sample = this.sample();
					if (!sample || !validCoordinates(sample.latitude, sample.longitude)) {
						fail();
						return;
					}
					settled = true;
					closeLocation();
					state.lat = sample.latitude;
					state.lon = sample.longitude;
					drawScreen();
					fetchWeather(state.lat, state.lon, true);
				} catch (e) {
					console.log("Location sample error: " + e);
					fail();
				}
			}
		});
		locationTimer = setTimeout(fail, WEATHER_TIMEOUT);
	} catch (e) {
		console.log("Location error: " + e);
		fail();
	}
}

let forecastGeneration = 0;
let forecastTimer = null;

function fetchWeather(latitude, longitude, allowRetry = true) {
	const generation = ++forecastGeneration;
	clearTimeout(forecastTimer);
	forecastTimer = null;
	if (!validCoordinates(latitude, longitude)) {
		weatherFailed();
		return;
	}
	startForecast(latitude, longitude, allowRetry, generation);
}

function startForecast(latitude, longitude, allowRetry, generation) {
	if (generation !== forecastGeneration)
		return;
	const deadline = Date.now() + WEATHER_TIMEOUT;
	let settled = false;
	const active = () => !settled && generation === forecastGeneration;
	const finish = () => {
		settled = true;
		clearTimeout(forecastTimer);
		forecastTimer = null;
	};
	const fail = () => {
		if (!active())
			return;
		finish();
		weatherFailed();
		if (allowRetry)
			forecastTimer = setTimeout(() => startForecast(latitude, longitude, false, generation), WEATHER_RETRY_DELAY);
	};
	const connect = () => {
		if (!active())
			return;
		if (Date.now() >= deadline) {
			fail();
			return;
		}
		if (!watch.connected.pebblekit) {
			forecastTimer = setTimeout(connect, 1000);
			return;
		}
		forecastTimer = setTimeout(fail, deadline - Date.now());
		getForecast(latitude, longitude, active, finish, fail);
	};
	connect();
}

async function getForecast(latitude, longitude, active, finish, fail) {
	try {
		const url = new URL("https://api.open-meteo.com/v1/forecast");
		url.search = new URLSearchParams({
			latitude,
			longitude,
			current: "temperature_2m,weather_code",
			hourly: "precipitation_probability",
			daily: "sunrise,sunset",
			timeformat: "unixtime",
			timezone: "auto",
			forecast_days: 2
		});
		const response = await fetch(url);
		if (!active())
			return;
		if (!response.ok)
			throw new Error("http " + response.status);
		const parsed = parseWeather(await response.json());
		if (!active())
			return;
		if (!parsed)
			throw new Error("bad weather json");
		finish();
		state.weather = parsed;
		state.updatedAt = Date.now();
		state.status = "ready";
		drawScreen();
	} catch (e) {
		console.log("Weather fetch error: " + e);
		fail();
	}
}

watch.addEventListener("minutechange", event => {
	if (state.weather && Date.now() - state.updatedAt >= 7200000)
		state.status = "stale";
	drawScreen(event);
});
watch.addEventListener("resize", drawScreen);
watch.addEventListener("hourchange", () => {
	if (state.lat === null)
		requestLocation();
	else
		fetchWeather(state.lat, state.lon, true);
});
drawScreen();
requestLocation();
