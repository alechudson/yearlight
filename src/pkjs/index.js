var sendTries = 0;
var lastPayload = null;
var CACHE_KEY = "wx1";

function sendToWatch(data) {
	var payload = typeof data === "string" ? data : JSON.stringify(data);
	if (payload !== lastPayload)
		sendTries = 0;
	lastPayload = payload;
	sendTries += 1;
	Pebble.sendAppMessage({ PAYLOAD: payload }, function () {
		console.log("pkjs sent " + payload.length);
		sendTries = 0;
	}, function () {
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

function fail(reason) {
	console.log("pkjs fail " + reason);
	sendToWatch(JSON.stringify({ error: 1 }));
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
	// Open-Meteo forecast API, CC BY 4.0: https://open-meteo.com/
	var url = "http://api.open-meteo.com/v1/forecast"
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
	xhr.onerror = function () { fail("wx net"); };
	xhr.ontimeout = function () { fail("wx timeout"); };
	xhr.send();
}

function ipLocate() {
	console.log("pkjs ip locate");
	var xhr = new XMLHttpRequest();
	xhr.open("GET", "http://ip-api.com/json/?fields=status,lat,lon", true); // ip-api.com, free non-commercial
	xhr.timeout = 10000;
	xhr.onload = function () {
		try {
			var data = JSON.parse(xhr.responseText);
			if (data.status !== "success" || !isFinite(data.lat) || !isFinite(data.lon)) {
				fail("ip json");
				return;
			}
			console.log("pkjs ip " + data.lat + "," + data.lon);
			fetchWeather(data.lat, data.lon);
		} catch (e) {
			fail("ip parse " + e);
		}
	};
	xhr.onerror = function () { fail("ip net"); };
	xhr.ontimeout = function () { fail("ip timeout"); };
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
		fetchWeather(cache.lat, cache.lon);
	}
	locateThenWeather(false);
});

Pebble.addEventListener("appmessage", function (e) {
	if (e.payload && e.payload.CMD)
		locateThenWeather(true);
});
