import Poco from "commodetto/Poco";
import Location from "embedded:sensor/Location";

const render = new Poco(screen);

const timeFont = new render.Font("Leco-Regular", 42);
const dateFont = new render.Font("Gothic-Bold", 18);
const tempFont = new render.Font("Leco-Bold", 36);
const labelFont = new render.Font("Gothic-Regular", 14);

const chassis = render.makeColor(0, 0, 0);
const steel = render.makeColor(170, 170, 170);
const steelDim = render.makeColor(85, 85, 85);
const lcdWell = render.makeColor(0, 85, 0);
const lcdGhost = render.makeColor(0, 0, 0);
const lcdOn = render.makeColor(170, 255, 85);
const lcdDim = render.makeColor(85, 170, 85);

const DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN",
	"JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

const MOODS = [
	{ maxCode: 0,  label: "CLEAR", icon: "sun" },
	{ maxCode: 3,  label: "CLOUD", icon: "cloud" },
	{ maxCode: 48, label: "FOG",   icon: "fog" },
	{ maxCode: 55, label: "DRZL",  icon: "rain" },
	{ maxCode: 65, label: "RAIN",  icon: "rain" },
	{ maxCode: 75, label: "SNOW",  icon: "snow" },
	{ maxCode: 82, label: "SHWR",  icon: "rain" },
	{ maxCode: 99, label: "STRM",  icon: "storm" },
];

const DEFAULT_MOOD = MOODS[0];

const state = {
	status: "loading",
	weather: null,
};

let lastDate = new Date();
let locationSensor = null;

function moodFor(code) {
	for (let i = 0; i < MOODS.length; i++) {
		if (code <= MOODS[i].maxCode)
			return MOODS[i];
	}
	return MOODS[MOODS.length - 1];
}

function parseWeather(data) {
	const current = data && data.current;
	if (!current)
		return null;
	const tempC = current.temperature_2m;
	const code = current.weather_code;
	if (typeof tempC !== "number" || typeof code !== "number")
		return null;
	return { tempC: Math.round(tempC), code };
}

function formatTime(now) {
	const minutes = String(now.getMinutes()).padStart(2, "0");
	if (watch.hour12) {
		let hours = now.getHours() % 12;
		if (hours === 0)
			hours = 12;
		return String(hours).padStart(2, " ") + ":" + minutes;
	}
	return String(now.getHours()).padStart(2, "0") + ":" + minutes;
}

function formatDate(now) {
	return DAYS[now.getDay()] + " " + String(now.getDate()).padStart(2, " ") + "-" + MONTHS[now.getMonth()];
}

function centerIn(str, font, x, w) {
	return (x + (w - render.getTextWidth(str, font)) / 2) | 0;
}

function pix(color, x, y, w, h) {
	render.fillRectangle(color, x, y, w, h);
}

const ICONS = {
	sun(cx, cy, on) {
		pix(on, cx - 7, cy - 7, 14, 14);
		pix(on, cx - 2, cy - 16, 4, 6);
		pix(on, cx - 2, cy + 10, 4, 6);
		pix(on, cx - 16, cy - 2, 6, 4);
		pix(on, cx + 10, cy - 2, 6, 4);
		pix(on, cx - 13, cy - 13, 4, 4);
		pix(on, cx + 9, cy - 13, 4, 4);
		pix(on, cx - 13, cy + 9, 4, 4);
		pix(on, cx + 9, cy + 9, 4, 4);
	},
	cloud(cx, cy, on) {
		pix(on, cx - 16, cy - 2, 32, 12);
		pix(on, cx - 8, cy - 10, 18, 10);
		pix(on, cx + 2, cy - 6, 12, 8);
	},
	rain(cx, cy, on) {
		ICONS.cloud(cx, cy - 4, on);
		pix(on, cx - 10, cy + 12, 3, 8);
		pix(on, cx - 1, cy + 14, 3, 8);
		pix(on, cx + 8, cy + 12, 3, 8);
	},
	snow(cx, cy, on) {
		pix(on, cx - 2, cy - 14, 4, 28);
		pix(on, cx - 14, cy - 2, 28, 4);
		pix(on, cx - 10, cy - 10, 4, 4);
		pix(on, cx + 6, cy - 10, 4, 4);
		pix(on, cx - 10, cy + 6, 4, 4);
		pix(on, cx + 6, cy + 6, 4, 4);
	},
	storm(cx, cy, on) {
		pix(on, cx - 4, cy - 16, 10, 8);
		pix(on, cx - 10, cy - 8, 12, 8);
		pix(on, cx - 2, cy, 10, 8);
		pix(on, cx - 8, cy + 8, 8, 10);
	},
	fog(cx, cy, on) {
		pix(on, cx - 18, cy - 10, 36, 4);
		pix(on, cx - 14, cy - 2, 28, 4);
		pix(on, cx - 18, cy + 6, 36, 4);
	},
};

function drawIcon(name, cx, cy, on) {
	const fn = ICONS[name] || ICONS.sun;
	fn(cx, cy, on);
}

function layout() {
	const area = render.unobstructed;
	const w = area.width;
	const h = area.height;
	const pad = h >= 220 ? 8 : 4;
	const lcdX = pad + 4;
	const lcdY = pad + 18;
	const lcdW = w - lcdX * 2;
	const lcdH = h - lcdY - pad;
	return {
		w,
		h,
		pad,
		lcdX,
		lcdY,
		lcdW,
		lcdH,
		cx: (w / 2) | 0,
		timeY: lcdY + 18,
		dateY: lcdY + 64,
		iconY: lcdY + 98,
		tempY: lcdY + lcdH - tempFont.height - labelFont.height - 8,
		condY: lcdY + lcdH - labelFont.height - 4,
	};
}

function drawScreen(event) {
	const now = event?.date ?? lastDate;
	if (event?.date)
		lastDate = event.date;

	const mood = state.weather ? moodFor(state.weather.code) : DEFAULT_MOOD;
	const pos = layout();

	render.begin();
	render.fillRectangle(chassis, 0, 0, render.width, render.height);

	const nimbus = "NIMBUS";
	render.drawText(nimbus, labelFont, steel, pos.pad, 4);
	const wr = "WR";
	render.drawText(wr, labelFont, steelDim,
		pos.w - pos.pad - render.getTextWidth(wr, labelFont), 4);

	pix(steel, pos.lcdX - 4, pos.lcdY - 4, pos.lcdW + 8, pos.lcdH + 8);
	pix(steelDim, pos.lcdX - 2, pos.lcdY - 2, pos.lcdW + 6, pos.lcdH + 6);
	pix(lcdWell, pos.lcdX, pos.lcdY, pos.lcdW, pos.lcdH);

	for (let y = pos.lcdY; y < pos.lcdY + pos.lcdH; y += 4)
		pix(lcdGhost, pos.lcdX, y, pos.lcdW, 1);

	const timeStr = formatTime(now);
	const ghost = "88:88";
	render.drawText(ghost, timeFont, lcdGhost,
		centerIn(ghost, timeFont, pos.lcdX, pos.lcdW), pos.timeY);
	render.drawText(timeStr, timeFont, lcdOn,
		centerIn(timeStr, timeFont, pos.lcdX, pos.lcdW), pos.timeY);

	if (watch.hour12) {
		const mark = now.getHours() >= 12 ? "PM" : "AM";
		render.drawText(mark, labelFont, lcdDim,
			pos.lcdX + pos.lcdW - render.getTextWidth(mark, labelFont) - 4,
			pos.timeY);
	}

	const dateStr = formatDate(now);
	render.drawText(dateStr, dateFont, lcdOn,
		centerIn(dateStr, dateFont, pos.lcdX, pos.lcdW), pos.dateY);

	drawIcon(mood.icon, pos.cx, pos.iconY, lcdOn);

	let tempStr = "--";
	if (state.weather)
		tempStr = String(state.weather.tempC).padStart(2, " ") + "C";
	render.drawText(tempStr, tempFont, lcdOn,
		centerIn(tempStr, tempFont, pos.lcdX, pos.lcdW), pos.tempY);

	let condStr = mood.label;
	if (state.status === "loading" && !state.weather)
		condStr = "WAIT";
	else if (state.status === "offline" && !state.weather)
		condStr = "NO LK";
	render.drawText(condStr, labelFont, lcdDim,
		centerIn(condStr, labelFont, pos.lcdX, pos.lcdW), pos.condY);

	render.end();
}

function requestLocation() {
	try {
		locationSensor?.close();
	} catch (_) {}
	locationSensor = null;

	if (!state.weather)
		state.status = "loading";

	try {
		locationSensor = new Location({
			onSample() {
				const sample = this.sample();
				this.close();
				locationSensor = null;
				fetchWeather(sample.latitude, sample.longitude, true);
			}
		});
	} catch (e) {
		console.log("Location error: " + e);
		if (!state.weather)
			state.status = "offline";
		drawScreen();
	}
}

function fetchWeather(latitude, longitude, allowRetry) {
	if (!watch.connected.pebblekit) {
		setTimeout(() => fetchWeather(latitude, longitude, allowRetry), 1000);
		return;
	}
	getForecast(latitude, longitude, allowRetry);
}

async function getForecast(latitude, longitude, allowRetry) {
	try {
		const url = new URL("http://api.open-meteo.com/v1/forecast");
		url.search = new URLSearchParams({
			latitude,
			longitude,
			current: "temperature_2m,weather_code"
		});
		const response = await fetch(url);
		if (!response.ok)
			throw new Error("http " + response.status);
		const parsed = parseWeather(await response.json());
		if (!parsed)
			throw new Error("bad weather json");
		state.weather = parsed;
		state.status = "ready";
		drawScreen();
	} catch (e) {
		console.log("Weather fetch error: " + e);
		if (allowRetry) {
			setTimeout(() => fetchWeather(latitude, longitude, false), 10000);
			return;
		}
		if (!state.weather)
			state.status = "offline";
		drawScreen();
	}
}

watch.addEventListener("minutechange", drawScreen);
watch.addEventListener("resize", drawScreen);
watch.addEventListener("hourchange", requestLocation);
