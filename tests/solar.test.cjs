const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../src/embeddedjs/main.js'), 'utf8');
const solar = source.slice(source.indexOf('function sunAt('), source.indexOf('function pad2('));
const ctx = vm.createContext({Math, Date, MAP_W:200, MAP_H:132});
vm.runInContext(solar, ctx);
vm.runInContext(`
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
`, ctx);
function look(lon, lat) {
 const r = lat * Math.PI / 180;
 return [lon * Math.PI / 180, Math.sin(r), Math.cos(r)];
}
const AM = look(-90, 15);
const GR = look(0, 0);
function night(lon, lat, iso) {
 return ctx.isNightXY((lon+180)/360*200, Math.sin(-lat*Math.PI/180), Math.cos(-lat*Math.PI/180),ctx.sunAt(new Date(iso)));
}
test('equinox: Greenwich noon is day, midnight is night', () => {
 assert.equal(night(0,0,'2026-03-20T12:00:00Z'),false);
 assert.equal(night(0,0,'2026-03-20T00:00:00Z'),true);
});
test('June solstice: Arctic is day and Antarctic is night', () => {
 for (const h of ['00','06','12','18']) {
  assert.equal(night(0,80,`2026-06-21T${h}:00:00Z`),false);
  assert.equal(night(0,-80,`2026-06-21T${h}:00:00Z`),true);
 }
});
test('December solstice: Arctic is night and Antarctic is day', () => {
 assert.equal(night(0,80,'2026-12-21T12:00:00Z'),true);
 assert.equal(night(0,-80,'2026-12-21T12:00:00Z'),false);
});
test('night spans are ordered and bounded throughout a year', () => {
 for(let month=0; month<12; month++) for(let y=0;y<100;y++) {
  const spans=ctx.nightSpansAt(y,ctx.sunAt(new Date(Date.UTC(2026,month,21,12))));
  assert.equal(spans.length%2,0);
  for(let i=0;i<spans.length;i+=2) {
   assert.ok(spans[i]>=0 && spans[i+1]<=200 && spans[i]<spans[i+1]);
   if(i) assert.ok(spans[i]>=spans[i-1]);
  }
 }
});
test('globe center follows the view origin', () => {
 const am = ctx.unprojectGlobe(100, 66, ...AM);
 assert.ok(am);
 assert.ok(Math.abs(am.lon + 90) < 2);
 assert.ok(Math.abs(am.lat - 15) < 2);
 const gr = ctx.unprojectGlobe(100, 66, ...GR);
 assert.ok(gr);
 assert.ok(Math.abs(gr.lon) < 2);
 assert.ok(Math.abs(gr.lat) < 2);
});
test('globe night matches lat/lon solar math', () => {
 const sun = ctx.sunAt(new Date('2026-03-20T18:00:00Z'));
 for (let y = 0; y < 132; y++) {
  for (let x = 0; x < 200; x++) {
   const p = ctx.unprojectGlobe(x, y, ...AM);
   if (!p) continue;
   assert.equal(ctx.isNightLonLat(p.lon, p.lat, sun), ctx.isNightXY((p.lon + 180) / 360 * 200, Math.sin(-p.lat * Math.PI / 180), Math.cos(-p.lat * Math.PI / 180), sun));
  }
 }
});
test('equinox: Americas globe center is day at 18:00Z and night at 06:00Z', () => {
 const p = ctx.unprojectGlobe(100, 66, ...AM);
 assert.equal(ctx.isNightLonLat(p.lon, p.lat, ctx.sunAt(new Date('2026-03-20T18:00:00Z'))), false);
 assert.equal(ctx.isNightLonLat(p.lon, p.lat, ctx.sunAt(new Date('2026-03-20T06:00:00Z'))), true);
});
test('globe night spans stay on the disc', () => {
 const sun = ctx.sunAt(new Date('2026-03-20T12:00:00Z'));
 for (let y = 0; y < 132; y++) {
  const spans = ctx.globeNightSpansAt(y, sun, ...AM);
  assert.equal(spans.length % 2, 0);
  for (let i = 0; i < spans.length; i += 2) {
   assert.ok(spans[i] >= 0 && spans[i + 1] <= 200 && spans[i] < spans[i + 1]);
   for (let x = spans[i]; x < spans[i + 1]; x++)
    assert.ok(ctx.unprojectGlobe(x, y, ...AM));
  }
 }
});
test('projecting the view origin lands on the globe center', () => {
 const pin = ctx.projectGlobe(-90, 15, ...AM);
 assert.ok(pin);
 assert.ok(Math.abs(pin.x - 100) <= 1);
 assert.ok(Math.abs(pin.y - 66) <= 1);
});
test('subsolar point is day and near Greenwich at noon', () => {
 const sun = ctx.sunAt(new Date('2026-03-20T12:00:00Z'));
 assert.ok(Math.abs(sun.lon) < 8);
 assert.ok(Math.abs(sun.lat) < 3);
 assert.equal(ctx.isNightLonLat(sun.lon, sun.lat, sun), false);
 const dusk = ctx.sunAt(new Date('2026-03-20T18:00:00Z'));
 assert.ok(Math.abs(dusk.lon + 90) < 8);
});
test('apparent sunset keeps Greenwich lit a few minutes after geometric dusk', () => {
 assert.equal(night(0,0,'2026-03-20T18:00:00Z'), false);
 assert.equal(night(0,0,'2026-03-20T18:12:00Z'), true);
});
