var sendTries = 0;
var lastPayload = null;
var sending = false;
var delivered = false;
var wxGen = 0;
var CACHE_KEY = "wx1";
var CACHE_FRESH_MS = 15 * 60 * 1000;
var SETTINGS_KEY = "cfg1";

function readSettings() {
	try {
		var saved = JSON.parse(localStorage.getItem(SETTINGS_KEY));
		return { units: saved && saved.units === "C" ? "C" : "F" };
	} catch (e) {
		return { units: "F" };
	}
}

function wireNum(value) {
	return typeof value === "number" && isFinite(value) ? String(value) : "";
}

// Open-Meteo is fetched and cached in °F; the chosen unit is applied on the
// way to the watch, so switching units just resends the cache.
function wireTemp(fahrenheit) {
	if (typeof fahrenheit !== "number" || !isFinite(fahrenheit) || readSettings().units !== "C")
		return fahrenheit;
	return Math.round((fahrenheit - 32) * 50 / 9) / 10;
}

// Flat CSV the watch can split without building JSON objects:
// lat,lon,updatedAt,temp,code,utcOffset[,day,sunrise,sunset]... ("" = missing, "E" = error).
function wirePayload(data) {
	if (!data || data.error)
		return "E";
	var weather = data.weather || {};
	var current = weather.current || {};
	var daily = weather.daily || {};
	var out = [wireNum(data.lat), wireNum(data.lon), wireNum(data.updatedAt),
		wireNum(wireTemp(current.temperature_2m)), wireNum(current.weather_code), wireNum(weather.utc_offset_seconds)];
	var time = Array.isArray(daily.time) ? daily.time : [];
	var sunrise = Array.isArray(daily.sunrise) ? daily.sunrise : [];
	var sunset = Array.isArray(daily.sunset) ? daily.sunset : [];
	for (var i = 0; i < time.length; i++)
		out.push(wireNum(time[i]), wireNum(sunrise[i]), wireNum(sunset[i]));
	return out.join(",");
}

function sendToWatch(data) {
	var payload = typeof data === "string" ? data : wirePayload(data);
	if (payload !== lastPayload)
		sendTries = 0;
	lastPayload = payload;
	if (sending)
		return;
	sending = true;
	sendTries += 1;
	var outgoing = lastPayload;
	Pebble.sendAppMessage({ PAYLOAD: outgoing }, function () {
		sending = false;
		sendTries = 0;
		if (outgoing !== "E")
			delivered = true;
		if (lastPayload !== outgoing)
			sendToWatch(lastPayload);
	}, function () {
		sending = false;
		console.log("pkjs send fail " + sendTries);
		if (sendTries < 6)
			setTimeout(function () { sendToWatch(lastPayload); }, 2000);
	});
}

function readCache() {
	try {
		var data = JSON.parse(localStorage.getItem(CACHE_KEY));
		if (!data || !isFinite(data.lat) || !isFinite(data.lon) || !data.weather)
			return null;
		return data;
	} catch (e) {
		return null;
	}
}

function writeCache(data) {
	try {
		localStorage.setItem(CACHE_KEY, JSON.stringify(data));
	} catch (e) {}
}

function cacheFresh(cache) {
	return cache && isFinite(cache.updatedAt) && Date.now() - cache.updatedAt < CACHE_FRESH_MS;
}

function fail(reason) {
	console.log("pkjs fail " + reason);
	if (delivered)
		return;
	sendToWatch({ error: 1 });
}

function slimWeather(data) {
	var current = data.current || {};
	var daily = data.daily || {};
	return {
		current: {
			temperature_2m: current.temperature_2m,
			weather_code: current.weather_code
		},
		utc_offset_seconds: data.utc_offset_seconds,
		daily: {
			time: daily.time,
			sunrise: daily.sunrise,
			sunset: daily.sunset
		}
	};
}

function fetchWeather(lat, lon) {
	console.log("pkjs weather " + lat + "," + lon);
	var gen = ++wxGen;
	// Open-Meteo forecast API, CC BY 4.0: https://open-meteo.com/
	var url = "https://api.open-meteo.com/v1/forecast"
		+ "?latitude=" + lat
		+ "&longitude=" + lon
		+ "&current=temperature_2m,weather_code"
		+ "&daily=sunrise,sunset"
		+ "&timeformat=unixtime&timezone=auto"
		+ "&temperature_unit=fahrenheit&forecast_days=2&past_days=1";
	var xhr = new XMLHttpRequest();
	xhr.open("GET", url, true);
	xhr.timeout = 15000;
	xhr.onload = function () {
		if (gen !== wxGen)
			return;
		if (xhr.status < 200 || xhr.status > 299) {
			fail("wx http " + xhr.status);
			return;
		}
		try {
			var data = {
				lat: lat,
				lon: lon,
				updatedAt: Date.now(),
				weather: slimWeather(JSON.parse(xhr.responseText))
			};
			writeCache(data);
			sendToWatch(data);
		} catch (e) {
			fail("wx json " + e);
		}
	};
	xhr.onerror = function () {
		if (gen !== wxGen)
			return;
		fail("wx net");
	};
	xhr.ontimeout = function () {
		if (gen !== wxGen)
			return;
		fail("wx timeout");
	};
	xhr.send();
}

function ipLocate() {
	console.log("pkjs ip locate");
	var gen = ++wxGen;
	// GeoJS IP geolocation, HTTPS, no API key: https://www.geojs.io/
	var xhr = new XMLHttpRequest();
	xhr.open("GET", "https://get.geojs.io/v1/ip/geo.json", true);
	xhr.timeout = 10000;
	xhr.onload = function () {
		if (gen !== wxGen)
			return;
		if (xhr.status < 200 || xhr.status > 299) {
			fail("ip http " + xhr.status);
			return;
		}
		try {
			var data = JSON.parse(xhr.responseText);
			var lat = +data.latitude;
			var lon = +data.longitude;
			if (!isFinite(lat) || !isFinite(lon)) {
				fail("ip json");
				return;
			}
			console.log("pkjs ip " + lat + "," + lon);
			fetchWeather(lat, lon);
		} catch (e) {
			fail("ip parse " + e);
		}
	};
	xhr.onerror = function () {
		if (gen !== wxGen)
			return;
		fail("ip net");
	};
	xhr.ontimeout = function () {
		if (gen !== wxGen)
			return;
		fail("ip timeout");
	};
	xhr.send();
}

function samePlace(aLat, aLon, bLat, bLon) {
	return Math.abs(aLat - bLat) < 0.05 && Math.abs(aLon - bLon) < 0.05;
}

function locateThenWeather(force) {
	var cache = readCache();
	var gotGps = false;
	function onGps(lat, lon) {
		if (gotGps)
			return;
		gotGps = true;
		if (!force && cache && samePlace(cache.lat, cache.lon, lat, lon))
			return;
		fetchWeather(lat, lon);
	}
	function onFail() {
		if (gotGps)
			return;
		gotGps = true;
		if (cache) {
			if (force)
				fetchWeather(cache.lat, cache.lon);
			return;
		}
		ipLocate();
	}
	if (!navigator.geolocation) {
		onFail();
		return;
	}
	if (!cache)
		setTimeout(onFail, 8000);
	navigator.geolocation.getCurrentPosition(
		function (pos) {
			console.log("pkjs gps " + pos.coords.latitude + "," + pos.coords.longitude);
			onGps(pos.coords.latitude, pos.coords.longitude);
		},
		function (err) {
			console.log("pkjs gps fail " + (err && err.code) + " " + (err && err.message));
			onFail();
		},
		{ enableHighAccuracy: false, timeout: 7000, maximumAge: 600000 }
	);
}

Pebble.addEventListener("ready", function () {
	console.log("pkjs ready");
	var cache = readCache();
	if (cache) {
		sendToWatch(cache);
		// Watchfaces relaunch after every notification or menu visit; a fresh
		// forecast means the location is fresh enough too.
		if (cacheFresh(cache))
			return;
		fetchWeather(cache.lat, cache.lon);
	}
	locateThenWeather(false);
});

Pebble.addEventListener("appmessage", function (e) {
	if (!(e.payload && e.payload.CMD))
		return;
	var cache = readCache();
	if (cacheFresh(cache))
		return;
	if (cache)
		fetchWeather(cache.lat, cache.lon);
	else
		locateThenWeather(true);
});

function settingsPage(settings) {
	function option(value, label) {
		return '<label><input type="radio" name="units" value="' + value + '"'
			+ (settings.units === value ? " checked" : "") + '> ' + label + '</label>';
	}
	var html = '<!DOCTYPE html><html><head><meta charset="utf-8">'
		+ '<meta name="viewport" content="width=device-width,initial-scale=1">'
		+ '<title>Yearlight</title><style>'
		+ ':root{color-scheme:light dark;--bg:#f4f3f4;--card:#fff;--ink:#111;--muted:#666;--line:#ddd;--accent:#0a58ca}'
		+ '@media (prefers-color-scheme:dark){:root{--bg:#111;--card:#1d1d1f;--ink:#f2f2f2;--muted:#9a9a9a;--line:#333;--accent:#4d8dff}}'
		+ '*{box-sizing:border-box}'
		+ 'body{margin:0;padding:24px 16px;background:var(--bg);color:var(--ink);font:17px -apple-system,system-ui,sans-serif}'
		+ 'h1{font-size:22px;margin:0 0 20px}'
		+ '.label{margin:0 4px 8px;color:var(--muted);font-size:13px;text-transform:uppercase;letter-spacing:.04em}'
		+ '.card{background:var(--card);border-radius:12px;padding:0 16px}'
		+ '.card label{display:block;padding:14px 0;font-size:18px}.card label+label{border-top:1px solid var(--line)}'
		+ 'input{width:20px;height:20px;margin:0 10px 0 0;vertical-align:-3px;accent-color:var(--accent)}'
		+ 'button{display:block;width:100%;margin-top:24px;padding:14px;border:0;border-radius:12px;background:var(--accent);color:#fff;font:600 18px -apple-system,system-ui,sans-serif}'
		+ '</style></head><body><h1>Yearlight</h1><div class="label">Temperature</div><div class="card">'
		+ option("F", "Fahrenheit (°F)") + option("C", "Celsius (°C)")
		+ '</div><button id="save">Save</button><script>'
		+ 'document.getElementById("save").onclick=function(){'
		+ 'var units=document.querySelector("input[name=units]:checked").value;'
		+ 'location.href="pebblejs://close#"+encodeURIComponent(JSON.stringify({units:units}));};'
		+ '</script></body></html>';
	return "data:text/html;charset=utf-8," + encodeURIComponent(html);
}

Pebble.addEventListener("showConfiguration", function () {
	Pebble.openURL(settingsPage(readSettings()));
});

Pebble.addEventListener("webviewclosed", function (e) {
	var chosen;
	try {
		chosen = JSON.parse(decodeURIComponent(e && e.response || ""));
	} catch (err) {
		return;
	}
	if (!chosen || (chosen.units !== "C" && chosen.units !== "F"))
		return;
	try {
		localStorage.setItem(SETTINGS_KEY, JSON.stringify({ units: chosen.units }));
	} catch (err) {}
	var cache = readCache();
	if (cache)
		sendToWatch(cache);
});
