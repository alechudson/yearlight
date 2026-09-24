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
  return {context, xhrs, sent, timers, listeners, store};
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
  assert.equal(JSON.parse(h.store.get('wx1')).lat, 30);
});

test('ready replays the last forecast before waiting on GPS', () => {
  const cache = {lat: 30, lon: -97, updatedAt: 1, weather: {current: {temperature_2m: 70, weather_code: 0}}};
  const h = loadPkjs({
    store: {wx1: JSON.stringify(cache)},
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

test('ready skips Open-Meteo when the cached forecast is still fresh', () => {
  const cache = {lat: 30, lon: -97, updatedAt: Date.now(), weather: {current: {temperature_2m: 70, weather_code: 0}}};
  let gpsCalls = 0;
  const h = loadPkjs({
    store: {wx1: JSON.stringify(cache)},
    geo: {
      getCurrentPosition() { gpsCalls += 1; },
    },
  });
  h.listeners.ready();
  assert.equal(h.sent.length, 1);
  assert.equal(h.xhrs.length, 0);
  assert.equal(gpsCalls, 0, 'a relaunch inside the fresh window skips the location fix');
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

test('hourly refresh reuses cached coordinates without a GPS fix', () => {
  const cache = {lat: 30, lon: -97, updatedAt: 1, weather: {current: {temperature_2m: 70, weather_code: 0}}};
  let gpsCalls = 0;
  const h = loadPkjs({
    store: {wx1: JSON.stringify(cache)},
    geo: {
      getCurrentPosition() { gpsCalls += 1; },
    },
  });
  h.listeners.appmessage({payload: {CMD: 1}});
  assert.equal(gpsCalls, 0);
  assert.equal(h.xhrs.length, 1);
  assert.match(h.xhrs[0].url, /latitude=30/);
});

test('hourly refresh skips the fetch when a launch just refreshed the forecast', () => {
  const cache = {lat: 30, lon: -97, updatedAt: Date.now(), weather: {current: {temperature_2m: 70, weather_code: 0}}};
  const h = loadPkjs({store: {wx1: JSON.stringify(cache)}, geo: {getCurrentPosition() {}}});
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
