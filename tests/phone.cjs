const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const OPEN_METEO = {
  latitude: 30, longitude: -97, generationtime_ms: 0.1, utc_offset_seconds: -18000,
  timezone: 'America/Chicago', timezone_abbreviation: 'GMT-5', elevation: 149,
  current_units: {time: 'unixtime', interval: 'seconds', temperature_2m: '°F', weather_code: 'wmo code'},
  current: {time: 1789055100, interval: 900, temperature_2m: 87.7, weather_code: 1},
  daily_units: {time: 'unixtime', sunrise: 'unixtime', sunset: 'unixtime'},
  daily: {
    time: [1, 2, 3],
    sunrise: [10, 20, 30],
    sunset: [11, 21, 31],
    temperature_2m_max: [90, 91, 92],
    temperature_2m_min: [70, 71, 72],
  },
};

function loadPkjs(options = {}) {
  const store = new Map(Object.entries(options.store || {}));
  const xhrs = [];
  const sent = [];
  const timers = [];
  const opened = [];
  const listeners = {};
  class XMLHttpRequest {
    constructor() {
      xhrs.push(this);
    }
    open(method, value) {
      this.method = method;
      this.url = value;
    }
    send() {
      this.sent = true;
    }
  }
  const localStorage = {
    getItem(key) { return store.has(key) ? store.get(key) : null; },
    setItem(key, value) { store.set(key, String(value)); },
  };
  const geo = options.geo === undefined ? undefined : options.geo;
  const context = vm.createContext({
    XMLHttpRequest,
    localStorage,
    Pebble: {
      addEventListener(name, fn) { listeners[name] = fn; },
      sendAppMessage(dict, ok, err) { sent.push({dict, ok, err}); },
      openURL(url) { opened.push(url); },
    },
    navigator: {geolocation: geo},
    console: {log() {}},
    setTimeout(fn, delay) { timers.push({fn, delay}); return timers.length; },
    Date,
    JSON,
    Math,
    isFinite,
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/pkjs/index.js'), 'utf8'), context);
  return {context, xhrs, sent, timers, listeners, store, opened};
}

function payloadOf(entry) {
  return entry.dict.PAYLOAD.split(',');
}

test('phone requests yesterday through tomorrow so a pre-dawn launch has the previous sunset', () => {
  const h = loadPkjs();
  vm.runInContext('fetchWeather(30, -97)', h.context);
  const url = new URL(h.xhrs[0].url);
  assert.equal(url.protocol, 'https:');
  assert.equal(url.hostname, 'api.open-meteo.com');
  assert.equal(url.searchParams.get('past_days'), '1');
  assert.equal(url.searchParams.get('forecast_days'), '2');
  assert.equal(url.searchParams.get('timeformat'), 'unixtime');
  assert.equal(url.searchParams.get('timezone'), 'auto');
  assert.equal(url.searchParams.get('temperature_unit'), 'fahrenheit');
  assert.deepEqual(url.searchParams.get('daily').split(','), ['sunrise', 'sunset']);
});

test('phone strips unused forecast fields before sending to the watch', () => {
  const h = loadPkjs();
  vm.runInContext('fetchWeather(30, -97)', h.context);
  const xhr = h.xhrs[0];
  xhr.status = 200;
  xhr.responseText = JSON.stringify(OPEN_METEO);
  xhr.onload();
  const [lat, lon, updatedAt, temp, code, offset, ...days] = payloadOf(h.sent[0]);
  assert.deepEqual([lat, lon, temp, code, offset], ['30', '-97', '87.7', '1', '-18000']);
  assert.ok(Number(updatedAt) > 0);
  assert.deepEqual(days, ['1', '10', '11', '2', '20', '21', '3', '30', '31']);
  assert.ok(h.sent[0].dict.PAYLOAD.length < 80, 'flat CSV, no JSON keys');
  assert.equal(JSON.parse(h.store.get('wx2')).lat, 30);
});

test('ready replays the last forecast before waiting on GPS', () => {
  const cache = {lat: 30, lon: -97, updatedAt: 1, weather: {current: {temperature_2m: 70, weather_code: 0}}};
  const h = loadPkjs({
    store: {wx2: JSON.stringify(cache)},
    geo: {
      getCurrentPosition() {},
    },
  });
  h.listeners.ready();
  assert.equal(h.sent.length, 1);
  assert.deepEqual(payloadOf(h.sent[0]).slice(3, 5), ['70', '0']);
  assert.equal(h.xhrs.length, 1);
  assert.match(h.xhrs[0].url, /latitude=30/);
  assert.equal(h.xhrs.some(x => /geojs/.test(x.url)), false);
});

function freshCache() {
  return {lat: 30, lon: -97, updatedAt: Date.now(), weather: {current: {temperature_2m: 70, weather_code: 0}}};
}

test('ready with a fresh forecast only takes a cheap network fix', () => {
  const geo = recordingGeo();
  const h = loadPkjs({store: {wx2: JSON.stringify(freshCache())}, geo});
  h.listeners.ready();
  assert.equal(h.sent.length, 1);
  assert.equal(h.xhrs.length, 0);
  assert.equal(geo.calls.length, 1);
  assert.equal(geo.calls[0].options.enableHighAccuracy, false);
  geo.calls[0].ok(fix(30.001, -97, 3000));
  assert.equal(geo.calls.length, 1, 'still in the same place, so no GPS');
  assert.equal(h.xhrs.length, 0);
  assert.equal(h.timers.some(t => t.delay === 5000), false, 'no GPS timer on a light check');
});

test('a fresh forecast follows the phone once the network fix moves', () => {
  const geo = recordingGeo();
  const h = loadPkjs({store: {wx2: JSON.stringify(freshCache())}, geo});
  h.listeners.ready();
  geo.calls[0].ok(fix(30.3, -97, 3000));
  assert.equal(geo.calls.length, 2);
  assert.equal(geo.calls[1].options.enableHighAccuracy, true);
  assert.equal(h.xhrs.length, 0, 'a loose fix waits on GPS');
  geo.calls[1].ok(fix(30.31, -97.01, 15));
  assert.equal(new URL(h.xhrs[0].url).searchParams.get('latitude'), '30.31');
});

test('a tight network fix in a new place fetches without waiting on GPS', () => {
  const geo = recordingGeo();
  const h = loadPkjs({store: {wx2: JSON.stringify(freshCache())}, geo});
  h.listeners.ready();
  geo.calls[0].ok(fix(30.3, -97, 50));
  assert.equal(new URL(h.xhrs[0].url).searchParams.get('latitude'), '30.3');
});

test('the phone rechecks location every ten minutes while the face runs', () => {
  const geo = recordingGeo();
  const h = loadPkjs({store: {wx2: JSON.stringify(freshCache())}, geo});
  h.listeners.ready();
  const tick = h.timers.find(t => t.delay === 600000);
  assert.ok(tick);
  tick.fn();
  assert.equal(geo.calls.length, 2);
  assert.equal(h.timers.filter(t => t.delay === 600000).length, 2, 'reschedules itself');
});

test('an old cached position is ignored instead of pinning the forecast', () => {
  const geo = recordingGeo();
  const h = loadPkjs({geo});
  h.listeners.ready();
  const old = fix(40, -74, 10);
  old.timestamp = Date.now() - 3 * 3600 * 1000;
  geo.calls[0].ok(old);
  assert.equal(h.xhrs.length, 0);
  const now = fix(30, -97, 10);
  now.timestamp = Date.now();
  geo.calls[1].ok(now);
  assert.equal(new URL(h.xhrs[0].url).searchParams.get('latitude'), '30');
});

test('GPS failure with no cache falls back to HTTPS IP geolocation then weather', () => {
  const h = loadPkjs();
  h.listeners.ready();
  const ipUrl = new URL(h.xhrs[0].url);
  assert.equal(ipUrl.protocol, 'https:');
  assert.equal(ipUrl.hostname, 'get.geojs.io');
  h.xhrs[0].status = 200;
  h.xhrs[0].responseText = JSON.stringify({latitude: '30.2', longitude: '-97.7'});
  h.xhrs[0].onload();
  const wxUrl = new URL(h.xhrs[1].url);
  assert.equal(wxUrl.hostname, 'api.open-meteo.com');
  assert.equal(wxUrl.searchParams.get('latitude'), '30.2');
  assert.equal(wxUrl.searchParams.get('longitude'), '-97.7');
});

function recordingGeo() {
  const calls = [];
  return {
    calls,
    getCurrentPosition(ok, err, options) {
      calls.push({ok, err, options});
    },
  };
}

function fix(lat, lon, accuracy) {
  return {coords: {latitude: lat, longitude: lon, accuracy}};
}

test('hourly refresh updates the cached forecast and requests a new fix', () => {
  const cache = {lat: 30, lon: -97, updatedAt: 1, weather: {current: {temperature_2m: 70, weather_code: 0}}};
  let gpsCalls = 0;
  const h = loadPkjs({
    store: {wx2: JSON.stringify(cache)},
    geo: {
      getCurrentPosition() { gpsCalls += 1; },
    },
  });
  h.listeners.appmessage({payload: {CMD: 1}});
  assert.equal(gpsCalls, 1);
  assert.equal(h.xhrs.length, 1);
  assert.match(h.xhrs[0].url, /latitude=30/);
});

test('a cold start sends the network fix, then a tighter GPS fix if it moved', () => {
  const geo = recordingGeo();
  const h = loadPkjs({geo});
  h.listeners.ready();
  assert.equal(geo.calls.length, 1);
  assert.equal(geo.calls[0].options.enableHighAccuracy, false);
  assert.equal(geo.calls[0].options.maximumAge, 60000);
  geo.calls[0].ok(fix(30, -97, 4000));
  assert.equal(new URL(h.xhrs[0].url).searchParams.get('latitude'), '30');
  assert.equal(geo.calls.length, 2);
  assert.equal(geo.calls[1].options.enableHighAccuracy, true);
  assert.equal(geo.calls[1].options.maximumAge, 0);
  assert.equal(geo.calls[1].options.timeout, 20000);
  geo.calls[1].ok(fix(30.05, -97, 20));
  assert.equal(new URL(h.xhrs[1].url).searchParams.get('latitude'), '30.05');
});

test('a worse GPS reading does not replace a tighter network fix', () => {
  const geo = recordingGeo();
  const h = loadPkjs({geo});
  h.listeners.ready();
  geo.calls[0].ok(fix(30.2, -97.2, 40));
  geo.calls[1].ok(fix(31, -98, 5000));
  assert.equal(h.xhrs.length, 1);
  assert.equal(new URL(h.xhrs[0].url).searchParams.get('latitude'), '30.2');
});

test('a cached forecast waits for GPS instead of adopting a loose network fix', () => {
  const cache = {lat: 30, lon: -97, updatedAt: 1, weather: {current: {temperature_2m: 70, weather_code: 0}}};
  const geo = recordingGeo();
  const h = loadPkjs({store: {wx2: JSON.stringify(cache)}, geo});
  h.listeners.ready();
  assert.equal(h.xhrs.length, 1);
  geo.calls[0].ok(fix(30.05, -97, 5000));
  assert.equal(h.xhrs.length, 1);
  geo.calls[1].ok(fix(30.001, -97, 25));
  assert.equal(h.xhrs.length, 1);
});

test('GPS replaces the cached place once it moves about two kilometers', () => {
  const cache = {lat: 30, lon: -97, updatedAt: 1, weather: {current: {temperature_2m: 70, weather_code: 0}}};
  const geo = recordingGeo();
  const h = loadPkjs({store: {wx2: JSON.stringify(cache)}, geo});
  h.listeners.ready();
  geo.calls[0].ok(fix(30, -97, 4000));
  assert.equal(h.xhrs.length, 1);
  geo.calls[1].ok(fix(30.04, -97.04, 30));
  assert.equal(h.xhrs.length, 2);
  const url = new URL(h.xhrs[1].url);
  assert.equal(url.searchParams.get('latitude'), '30.04');
  assert.equal(url.searchParams.get('longitude'), '-97.04');
});

test('network and GPS failure with no cache falls back to IP geolocation', () => {
  const geo = recordingGeo();
  const h = loadPkjs({geo});
  h.listeners.ready();
  geo.calls[0].err({code: 1, message: 'denied'});
  geo.calls[1].err({code: 1, message: 'denied'});
  assert.equal(new URL(h.xhrs[0].url).hostname, 'get.geojs.io');
});

test('a hung location request falls back to IP geolocation', () => {
  const h = loadPkjs({geo: {getCurrentPosition() {}}});
  h.listeners.ready();
  assert.equal(h.xhrs.length, 0);
  h.timers.find((t) => t.delay === 27000).fn();
  assert.equal(new URL(h.xhrs[0].url).hostname, 'get.geojs.io');
});

test('a late GPS fix replaces an IP fallback', () => {
  const geo = recordingGeo();
  const h = loadPkjs({geo});
  h.listeners.ready();
  h.timers.find((t) => t.delay === 27000).fn();
  h.xhrs[0].status = 200;
  h.xhrs[0].responseText = JSON.stringify({latitude: '1', longitude: '2'});
  h.xhrs[0].onload();
  const before = h.xhrs.length;
  h.timers.find((t) => t.delay === 5000).fn();
  geo.calls[1].ok(fix(30, -97, 15));
  assert.equal(h.xhrs.length, before + 1);
  assert.equal(new URL(h.xhrs.at(-1).url).searchParams.get('latitude'), '30');
});

test('hourly refresh skips the fetch when a launch just refreshed the forecast', () => {
  const cache = {lat: 30, lon: -97, updatedAt: Date.now(), weather: {current: {temperature_2m: 70, weather_code: 0}}};
  const h = loadPkjs({store: {wx2: JSON.stringify(cache)}, geo: {getCurrentPosition() {}}});
  h.listeners.appmessage({payload: {CMD: 1}});
  assert.equal(h.xhrs.length, 0);
});

test('a second send waits until the first AppMessage settles', () => {
  const h = loadPkjs();
  vm.runInContext('sendToWatch("a"); sendToWatch("b")', h.context);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].dict.PAYLOAD, 'a');
  h.sent[0].ok();
  assert.equal(h.sent.length, 2);
  assert.equal(h.sent[1].dict.PAYLOAD, 'b');
});

test('an error payload is a bare E', () => {
  const h = loadPkjs();
  vm.runInContext('fail("wx net")', h.context);
  assert.equal(h.sent[0].dict.PAYLOAD, 'E');
});

test('fail does not send an error after a forecast already landed', () => {
  const h = loadPkjs();
  vm.runInContext('sendToWatch({lat:30,lon:-97,weather:{current:{temperature_2m:70,weather_code:0}}})', h.context);
  h.sent[0].ok();
  vm.runInContext('fail("wx net")', h.context);
  assert.equal(h.sent.length, 1);
});

const CACHED = {lat: 30, lon: -97, updatedAt: 1, weather: {current: {temperature_2m: 70, weather_code: 0}}};

test('temperatures go to the watch in Fahrenheit by default', () => {
  const h = loadPkjs({store: {wx2: JSON.stringify(CACHED)}, geo: {getCurrentPosition() {}}});
  h.listeners.ready();
  assert.equal(payloadOf(h.sent[0])[3], '70');
});

test('choosing Celsius saves it and resends the cached forecast converted', () => {
  const h = loadPkjs({store: {wx2: JSON.stringify(CACHED)}});
  h.listeners.webviewclosed({response: encodeURIComponent(JSON.stringify({units: 'C'}))});
  assert.equal(JSON.parse(h.store.get('cfg1')).units, 'C');
  assert.equal(h.xhrs.length, 0, 'switching units needs no network');
  assert.equal(payloadOf(h.sent[0])[3], '21.1');
  h.sent[0].ok();
  h.listeners.webviewclosed({response: encodeURIComponent(JSON.stringify({units: 'F'}))});
  assert.equal(payloadOf(h.sent[1])[3], '70');
});

test('a cancelled or malformed settings page changes nothing', () => {
  const h = loadPkjs({store: {wx2: JSON.stringify(CACHED)}});
  for (const response of ['', 'CANCELLED', '%7B', encodeURIComponent('{"units":"K"}')])
    h.listeners.webviewclosed({response});
  h.listeners.webviewclosed(undefined);
  assert.equal(h.store.has('cfg1'), false);
  assert.equal(h.sent.length, 0);
});

test('the settings page opens with the current unit selected', () => {
  const h = loadPkjs({store: {cfg1: JSON.stringify({units: 'C'})}});
  h.listeners.showConfiguration();
  assert.match(h.opened[0], /^data:text\/html;charset=utf-8,/);
  const page = decodeURIComponent(h.opened[0].slice(h.opened[0].indexOf(',') + 1));
  assert.match(page, /value="C" checked/);
  assert.doesNotMatch(page, /value="F" checked/);
  assert.match(page, /pebblejs:\/\/close#/);
});
