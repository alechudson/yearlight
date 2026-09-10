const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

test('phone requests yesterday solar events so a pre-dawn launch has the previous sunset', () => {
  let url;
  class XMLHttpRequest {
    open(method, value) { assert.equal(method, 'GET'); url = new URL(value); }
    send() {}
  }
  const context = vm.createContext({XMLHttpRequest, Pebble:{addEventListener(){}}, console:{log(){}}});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/pkjs/index.js'), 'utf8'), context);
  vm.runInContext('fetchWeather(30, -97)', context);
  assert.equal(url.searchParams.get('past_days'), '1');
  assert.equal(url.searchParams.get('forecast_days'), '7');
  assert.equal(url.searchParams.get('timeformat'), 'unixtime');
  assert.equal(url.searchParams.get('timezone'), 'auto');
  assert.equal(url.searchParams.get('temperature_unit'), 'fahrenheit');
  assert.ok(url.searchParams.get('daily').split(',').includes('sunrise'));
  assert.ok(url.searchParams.get('daily').split(',').includes('sunset'));
});
