const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function boot() {
  let now = Date.UTC(2026, 8, 9, 18);
  const calls = [], events = {};
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  class Poco {
    constructor() {
      this.Font = class { constructor(name, size) { this.name = name; this.size = size; } };
      this.unobstructed = {width:200, height:228};
    }
    makeColor(r, g, b) { return (r << 16) | (g << 8) | b; }
    begin() { calls.length = 0; }
    end() {}
    fillRectangle(color, x, y, width, height) { calls.push({kind:'rect', color, x, y, width, height}); }
    drawText(text, font, color, x, y) { calls.push({kind:'text', text, font, color, x, y, width:this.getTextWidth(text, font)}); }
    getTextWidth(text, font) { return String(text).length * Math.ceil(font.size * 0.5); }
  }
  class Message { constructor() {} }
  const context = vm.createContext({Poco, Message, screen:{}, Date:Clock, console:{log(){}},
    watch:{hour12:false, addEventListener(name, fn) { events[name] = fn; }},
    setTimeout(){}, clearTimeout(){}});
  for (const file of ['worldmask', 'yearstars', 'main']) {
    const source = fs.readFileSync(path.join(__dirname, `../src/embeddedjs/${file}.js`), 'utf8')
      .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
    vm.runInContext(source, context);
  }
  const evaluate = code => vm.runInContext(code, context);
  return {context, calls, events, eval:evaluate,
    deliver(data) { context.payload = JSON.stringify(data); evaluate('applyPayload(payload)'); },
    tick(iso) { now = Date.parse(iso); events.minutechange({date:new Clock()}); },
    texts() { return calls.filter(c => c.kind === 'text').map(c => c.text); }};
}

function forecast() {
  const sec = Date.UTC(2026, 8, 9) / 1000;
  return {lat:30, lon:-97, weather:{current:{temperature_2m:82, weather_code:0},
    utc_offset_seconds:-18000,
    daily:{time:[sec+18000, sec+104400],
      temperature_2m_max:[89,90], temperature_2m_min:[72,73],
      sunrise:[sec+43200, sec+129600], sunset:[sec+86400, sec+172800]}}};
}

test('night globe stays a full palette step darker than day', () => {
  const h = boot();
  assert.equal(h.eval('nightOcean'), 170);
  assert.equal(h.eval('dayOcean'), 0x0055ff);
  assert.equal(h.eval('nightLand'), 0x005500);
  assert.equal(h.eval('dayLand'), 0x00ff00);
});

test('Daylight HUD replaces the week sticks with local sunrise, sunset and a noon marker', () => {
  const h = boot();
  h.deliver(forecast());
  assert.ok(h.texts().includes('RISE 07:00'), 'sunrise uses the forecast location offset');
  assert.ok(h.texts().includes('SET 19:00'));
  assert.ok(h.texts().includes('82°'));
  const clock = h.calls.find(c => c.kind === 'text' && c.font.size === 42);
  assert.equal(clock.color, 0);
  assert.ok(h.calls.some(c => c.kind === 'rect' && c.color === 0xffffff && c.y === 132 && c.height >= 90));
  assert.ok(h.calls.some(c => c.kind === 'rect' && c.color === 0 && c.x <= 100 && c.x + c.width > 100 && c.y <= 205 && c.y + c.height >= 205 && c.height >= 7), 'midday marker is centered on the ruler');
  assert.ok(!h.calls.some(c => c.kind === 'rect' && c.color === 0xffffff && c.y >= 210 && c.width === 2 && c.height > 1), 'old weekly sticks are removed');
});

test('weather conditions render distinct pixel icons with a moon for clear nights', () => {
  const h = boot();
  const shapes = new Set();
  for (const code of [0,3,45,61,71,95]) {
    const data = forecast();
    data.weather.current.weather_code = code;
    h.deliver(data);
    const pixels = h.calls.filter(c => c.kind === 'rect' && c.y >= 180 && c.y < 198);
    assert.ok(pixels.length > 0, `icon exists for WMO ${code}`);
    shapes.add(JSON.stringify(pixels));
  }
  assert.equal(shapes.size, 6);
  h.deliver(forecast());
  const day = h.calls.filter(c => c.kind === 'rect' && c.y >= 180 && c.y < 198);
  h.tick('2026-09-09T06:00:00Z');
  const night = h.calls.filter(c => c.kind === 'rect' && c.y >= 180 && c.y < 198);
  assert.notDeepEqual(night, day);
});

test('night runs from sunset to next sunrise without resetting at either midnight', () => {
  const h = boot();
  const data = forecast();
  data.weather.daily.sunrise[1] += 3600;
  h.deliver(data);
  const fillWidth = () => h.calls.find(c => c.kind === 'rect' && c.color === 0x0000ff && c.y === 205 && c.height === 1)?.width;
  h.tick('2026-09-10T00:10:00Z');
  assert.deepEqual(h.texts().filter(t => /^(RISE|SET) /.test(t)), ['SET 19:00', 'RISE 08:00']);
  assert.ok(fillWidth() > 0, 'night fill starts after sunset');
  h.tick('2026-09-10T04:59:00Z');
  const beforeMidnight = fillWidth();
  h.tick('2026-09-10T05:01:00Z');
  assert.ok(fillWidth() >= beforeMidnight, 'progress continues across location midnight');
  assert.deepEqual(h.texts().filter(t => /^(RISE|SET) /.test(t)), ['SET 19:00', 'RISE 08:00']);
  assert.ok(h.calls.some(c => c.kind === 'rect' && c.color === 0 && c.y <= 205 && c.y + c.height >= 205 && c.height >= 7 && c.width >= 7), 'progress dot');
  h.tick('2026-09-10T13:00:00Z');
  assert.deepEqual(h.texts().filter(t => /^(RISE|SET) /.test(t)), ['RISE 08:00', 'SET 19:00']);
  assert.ok(h.calls.some(c => c.kind === 'rect' && c.color === 0 && c.x <= 13 && c.y <= 205 && c.y + c.height >= 205 && c.width >= 7), 'sunrise starts the next daylight interval');
});

test('12-hour mode labels both clock and solar times without squeezing the caption', () => {
  const h = boot();
  h.eval('watch.hour12 = true');
  const data = forecast();
  data.weather.current.temperature_2m = 104;
  h.deliver(data);
  const clock = h.calls.find(c => c.kind === 'text' && c.font.size === 42);
  const period = h.calls.find(c => c.kind === 'text' && (c.text === 'AM' || c.text === 'PM'));
  assert.ok(period);
  assert.equal(clock.x, ((200 - clock.width) / 2) | 0, 'clock digits are centered without AM/PM');
  assert.ok(period.x >= clock.x + clock.width);
  assert.ok(h.texts().includes('RISE 7:00a'));
  assert.ok(h.texts().includes('SET 7:00p'));
  h.deliver({error:1});
  const caption = h.calls.filter(c => c.kind === 'text' && c.y === 178);
  assert.ok(caption[0].x + caption[0].width + 6 <= caption[1].x - 22);
  assert.ok(h.calls.filter(c => c.kind === 'text').every(c => c.x >= 0 && c.x + c.width <= 200));
});

test('a fresh pre-dawn launch keeps yesterday sunset while the temperature forecast starts today', () => {
  const h = boot();
  h.tick('2026-09-09T06:00:00Z');
  const data = forecast();
  for (const key of ['time','sunrise','sunset'])
    data.weather.daily[key].unshift(data.weather.daily[key][0] - 86400);
  data.weather.daily.temperature_2m_max.unshift(100);
  data.weather.daily.temperature_2m_min.unshift(80);
  h.deliver(data);
  assert.deepEqual(h.texts().filter(t => /^(RISE|SET) /.test(t)), ['SET 19:00','RISE 07:00']);
  assert.equal(h.eval('solarPhaseFor(new Date()).night'), true);
  assert.ok(h.calls.some(c => c.kind === 'rect' && c.color === 0x0000ff && c.width > 0));
  h.deliver(data);
  assert.equal(h.eval('solarPhaseFor(new Date()).night'), true, 'refresh does not drop the preceding sunset');
});

test('phase changes happen exactly at sunset and sunrise, with markers inside the ruler', () => {
  const h = boot();
  h.deliver(forecast());
  for (const [iso, night] of [
    ['2026-09-09T23:59:59Z', false], ['2026-09-10T00:00:00Z', true],
    ['2026-09-10T11:59:59Z', true], ['2026-09-10T12:00:00Z', false]
  ]) {
    h.tick(iso);
    assert.equal(h.eval('solarPhaseFor(new Date()).night'), night, iso);
    const marks = h.calls.filter(c => c.kind === 'rect' && c.y >= 200);
    assert.ok(marks.every(c => c.x >= 0 && c.x + c.width <= 200 && c.height >= 0 && c.width >= 0));
  }
});

test('missing, polar, expired and non-adjacent solar data show no invented progress', () => {
  for (const kind of ['missing', 'polar', 'expired', 'gap', 'zero']) {
    const h = boot();
    const data = forecast();
    if (kind === 'missing') delete data.weather.daily;
    if (kind === 'polar') { data.weather.daily.sunrise = [0, 0]; data.weather.daily.sunset = [0, 0]; }
    if (kind === 'gap') { data.weather.daily.time[1] += 86400; data.weather.daily.sunrise[1] += 86400; data.weather.daily.sunset[1] += 86400; }
    if (kind === 'zero') data.weather.daily.sunset = [...data.weather.daily.sunrise];
    h.deliver(data);
    h.tick(kind === 'expired' ? '2026-09-12T06:00:00Z' : kind === 'zero' ? '2026-09-09T06:00:00Z' : '2026-09-10T06:00:00Z');
    assert.equal(h.eval('solarPhaseFor(new Date())'), null, kind);
    assert.ok(h.texts().includes('RISE --:--'), kind);
    assert.ok(!h.calls.some(c => c.kind === 'rect' && c.y >= 200 && [0x0000ff,0xffaa00].includes(c.color)), kind);
  }
});

test('a yellow sun mark sits at the subsolar point', () => {
  const h = boot();
  h.deliver(forecast());
  const pip = h.eval('(()=>{const o=viewOrigin();const lat0=o.lat*Math.PI/180;const s=sunAt(new Date());return projectGlobe(s.lon,s.lat,o.lon*Math.PI/180,Math.sin(lat0),Math.cos(lat0));})()');
  assert.ok(pip);
  assert.equal(h.eval('isNightLonLat(sunAt(new Date()).lon, sunAt(new Date()).lat, sunAt(new Date()))'), false);
  assert.ok(h.calls.some(c => c.kind === 'rect' && c.color === 0xffff00 && c.y < 132
    && c.x <= pip.x && c.x + c.width > pip.x && c.y <= pip.y && c.y + c.height > pip.y));
});

test('solstice and equinox stars stay cyan before they light', () => {
  const h = boot();
  h.deliver(forecast());
  for (const i of [78, 171, 264, 354]) {
    const x = h.eval('STAR_X[' + i + ']');
    const y = h.eval('STAR_Y[' + i + ']');
    assert.ok(h.calls.some(c => c.kind === 'rect' && c.color === 0x00ffff && c.x === x && c.y === y), 'season star ' + i);
  }
});

test('moon phase sits beside the date', () => {
  const h = boot();
  assert.equal(h.eval("moonPhaseIndex(new Date('2000-01-06T18:14:00Z'))"), 0);
  assert.equal(h.eval("moonPhaseIndex(new Date('2000-01-21T04:40:00Z'))"), 4);
  h.deliver(forecast());
  const date = h.calls.find(c => c.kind === 'text' && c.y === 178 && !c.text.includes('°'));
  const temp = h.calls.find(c => c.kind === 'text' && c.text === '82°');
  const index = h.eval('moonPhaseIndex(new Date())');
  const rows = h.eval('MOON_PHASES[' + index + ']');
  let bits = 0;
  for (const row of rows)
    for (let col = 0; col < 7; col++)
      if (row & (0x40 >> col)) bits++;
  const pixels = h.calls.filter(c => c.kind === 'rect' && c.color === 0 && c.width === 2 && c.height === 2
    && c.y >= 180 && c.y < 198);
  assert.equal(pixels.length, bits);
  assert.ok(bits > 0);
  assert.ok(pixels.every(c => c.x >= date.x + date.width));
  assert.ok(pixels.every(c => c.x + c.width <= temp.x - 22));
  assert.notDeepEqual(h.eval('MOON_PHASES[0]'), h.eval('MOON_PHASES[4]'));
});





