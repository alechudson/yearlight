var sendTries = 0;
var lastPayload = null;

function sendToWatch(payload) {
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

function fail(reason) {
	console.log("pkjs fail " + reason);
	sendToWatch(JSON.stringify({ error: 1 }));
}

function fetchWeather(lat, lon) {
	console.log("pkjs weather " + lat + "," + lon);
	var url = "http://api.open-meteo.com/v1/forecast"
		+ "?latitude=" + lat
		+ "&longitude=" + lon
		+ "&current=temperature_2m,weather_code"
		+ "&daily=temperature_2m_max,temperature_2m_min,sunrise,sunset"
		+ "&timeformat=unixtime&timezone=auto"
		+ "&temperature_unit=fahrenheit&forecast_days=7&past_days=1";
	var xhr = new XMLHttpRequest();
	xhr.open("GET", url, true);
	xhr.timeout = 15000;
	xhr.onload = function () {
		if (xhr.status < 200 || xhr.status > 299) {
			fail("wx http " + xhr.status);
			return;
		}
		try {
			sendToWatch(JSON.stringify({
				lat: lat,
				lon: lon,
				weather: JSON.parse(xhr.responseText)
			}));
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
	xhr.open("GET", "http://ip-api.com/json/?fields=status,lat,lon", true);
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

function locateThenWeather() {
	var settled = false;
	function go(lat, lon) {
		if (settled)
			return;
		settled = true;
		fetchWeather(lat, lon);
	}
	function startIp() {
		if (settled)
			return;
		settled = true;
		ipLocate();
	}
	if (!navigator.geolocation) {
		startIp();
		return;
	}
	setTimeout(startIp, 8000);
	navigator.geolocation.getCurrentPosition(
		function (pos) {
			console.log("pkjs gps " + pos.coords.latitude + "," + pos.coords.longitude);
			go(pos.coords.latitude, pos.coords.longitude);
		},
		function (err) {
			console.log("pkjs gps fail " + (err && err.code) + " " + (err && err.message));
			startIp();
		},
		{ enableHighAccuracy: false, timeout: 7000, maximumAge: 600000 }
	);
}

Pebble.addEventListener("ready", function () {
	console.log("pkjs ready");
	locateThenWeather();
});

Pebble.addEventListener("appmessage", function (e) {
	if (e.payload && e.payload.CMD)
		locateThenWeather();
});
