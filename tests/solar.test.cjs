const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../src/embeddedjs/main.js'), 'utf8');
const solar = source.slice(source.indexOf('function sunAt('), source.indexOf('function ensureMaps('));
const ctx = vm.createContext({Math, Date, MAP_W:200, MAP_H:100});
vm.runInContext(solar, ctx);
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
