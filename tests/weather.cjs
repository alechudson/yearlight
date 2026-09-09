const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
function boot(connected = true) {
  let now = Date.UTC(2026, 8, 9, 12), serial = 0;
  const timers = new Map(), sensors = [], requests = [], events = {}, texts = [];
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  class Poco { constructor() { this.Font = class {}; this.unobstructed = {width:200,height:228}; } makeColor(){return 0;} begin(){} end(){} fillRectangle(){} drawBitmap(){} drawLine(){} drawText(text){texts.push(text);} getTextWidth(){return 0;} }
  Poco.PebbleBitmap = class {};
  class Location { constructor(options) { this.options=options; sensors.push(this); } sample(){return this.value;} close(){this.closed=true;} emit(value){this.value=value; this.options.onSample.call(this);} }
  const context = vm.createContext({Poco, Location, screen:{}, Date:Clock, console:{log(){}}, URL, URLSearchParams,
    watch:{hour12:false, connected:{pebblekit:connected}, addEventListener(name, fn){events[name]=fn;}},
    setTimeout(fn, delay){const id=++serial; timers.set(id,{fn, at:now+delay}); return id;}, clearTimeout(id){timers.delete(id);},
    fetch(url){return new Promise((resolve,reject)=>requests.push({url:String(url), resolve, reject}));}});
  const mask = fs.readFileSync(path.join(__dirname,'../src/embeddedjs/worldmask.js'),'utf8').replace(/^export /gm,'');
  vm.runInContext(mask, context);
  const source = fs.readFileSync(path.join(__dirname,'../src/embeddedjs/main.js'),'utf8').replace(/^import .*;\r?\n/gm,'');
  vm.runInContext(source,context);
  return {context,sensors,requests,events,timers,texts, eval:code=>vm.runInContext(code,context),
    async flush(){for(let i=0;i<8;i++) await Promise.resolve();},
    async advance(ms){const end=now+ms; let count=0; while(true){const next=[...timers].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0]; if(!next)break; if(++count>1000)throw Error('unbounded timers'); now=next[1].at; timers.delete(next[0]); next[1].fn(); await this.flush();} now=end;},
    sample(){sensors.at(-1).emit({latitude:30,longitude:-97});},
    async respond(data){requests.at(-1).resolve({ok:true,json:async()=>data});await this.flush();}};
}
const valid = () => ({current:{temperature_2m:21.4,weather_code:1}});
const moodGroups = {
  CLEAR:[0], CLOUD:[1,2,3], FOG:[45,48], DRIZL:[51,53,55,56,57],
  RAIN:[61,63,65,66,67], SNOW:[71,73,75,77,85,86], SHWR:[80,81,82], STORM:[95,96,99]
};
for (const [mood,codes] of Object.entries(moodGroups)) {
  for (const code of codes) {
    test(`accepted WMO code ${code} has mood ${mood}`,()=>{
      const h=boot();
      h.context.data={current:{temperature_2m:20,weather_code:code}};
      assert.notEqual(h.eval('parseWeather(data)'),null);
      assert.equal(h.eval(`moodFor(${code})`),mood);
    });
  }
}
test('startup requests location and hourly event refreshes weather', async()=>{
  const h=boot(); assert.equal(h.sensors.length,1); h.sample(); await h.respond(valid());
  assert.equal(h.eval('state.status'),'ready'); assert.equal(typeof h.events.hourchange,'function');
  h.events.hourchange(); assert.equal(h.requests.length,2);
});
test('forecast request and parser use UTC seconds with the matching daily entry', async()=>{
  const h=boot(); h.sample(); const url=new URL(h.requests[0].url);
  assert.equal(url.protocol,'https:');
  assert.equal(url.searchParams.get('hourly'),'precipitation_probability');
  assert.equal(url.searchParams.get('daily'),'sunrise,sunset');
  assert.equal(url.searchParams.get('timeformat'),'unixtime');
  assert.equal(url.searchParams.get('timezone'),'auto');
  assert.equal(url.searchParams.get('temperature_unit'),'fahrenheit');
  const sec=Date.UTC(2026,8,9)/1000;
  await h.respond({...valid(), hourly:{time:[sec+10*3600,sec+12*3600,sec+13*3600],precipitation_probability:[90,20,30]}, daily:{time:[sec-86400,sec,sec+86400],sunrise:[sec-64800,sec+21600,sec+108000],sunset:[sec-21600,sec+64800,sec+151200]}});
  assert.equal(h.eval('state.weather.hours.length'),1);
  assert.equal(h.eval('state.weather.hours[0].precip'),30);
  assert.equal(h.eval('state.weather.sunrise.getTime()'),(sec+21600)*1000);
  assert.ok(h.texts.includes('21F  CLOUD'));
});
test('precipitation uses interval ends strictly after now, including within the hour',async()=>{
  const h=boot();
  const sec=Date.UTC(2026,8,9)/1000;
  h.context.data={...valid(),hourly:{time:[sec+11*3600,sec+12*3600,sec+13*3600,sec+14*3600],precipitation_probability:[90,80,30,40]}};
  const samples=()=>Array.from(h.eval('parseWeather(data).hours'),hour=>hour.precip);
  assert.deepEqual(samples(),[30,40]); // The interval ending exactly now has ended.
  await h.advance(30*60000);
  assert.deepEqual(samples(),[30,40]); // Do not retain the interval ending at 12:00.
  await h.advance(30*60000-1);
  assert.deepEqual(samples(),[30,40]); // Keep the interval ending one millisecond ahead.
  await h.advance(1);
  assert.deepEqual(samples(),[40]); // Drop it as soon as its end equals now.
});
test('parser rejects invalid current data and omits invalid optional samples',()=>{
  const h=boot();
  for(const value of [NaN,Infinity,null,'20']) { h.context.data={current:{temperature_2m:value,weather_code:1}}; assert.equal(h.eval('parseWeather(data)'),null); }
  for(const code of [undefined,null,NaN,Infinity,-1,4,100,'1']) { h.context.data={current:{temperature_2m:20,weather_code:code}}; assert.equal(h.eval('parseWeather(data)'),null); }
  const sec=Date.UTC(2026,8,9)/1000;
  h.context.data={...valid(),hourly:{time:[sec+43200,sec+46800,sec+50400,sec+54000,sec+57600],precipitation_probability:[null,-1,101,'20',0]},daily:{time:[sec],sunrise:[null],sunset:['bad']}};
  assert.equal(h.eval('parseWeather(data).hours.length'),1);
  assert.equal(h.eval('parseWeather(data).hours[0].precip'),0);
  assert.equal(h.eval('parseWeather(data).sunrise'),null);
  assert.equal(h.eval('parseWeather(data).sunset'),null);
  h.context.data={...valid(),hourly:{time:[sec+43200]}};
  assert.equal(h.eval('parseWeather(data).hours.length'),0);
});
test('location failure settles, closes sensors and ignores superseded callbacks',async()=>{
  const h=boot(); const old=h.sensors[0];
  h.eval('requestLocation()'); old.emit({latitude:1,longitude:2});
  assert.equal(h.requests.length,0);
  h.sensors.at(-1).emit({latitude:NaN,longitude:181});
  assert.equal(h.eval('state.status'),'offline');
  assert.equal(h.eval('state.lat'),null);
  await h.advance(120000);
  assert.ok(h.sensors.every(s=>s.closed));
  assert.equal(h.timers.size,0);
  assert.ok(h.sensors.length<=3);
  h.events.hourchange(); h.sample(); await h.respond(valid());
  assert.equal(h.eval('state.status'),'ready');
});
test('silent location sensors time out instead of waiting forever',async()=>{
  const h=boot(); await h.advance(120000);
  assert.equal(h.eval('state.status'),'offline');
  assert.equal(h.timers.size,0); assert.ok(h.sensors.every(s=>s.closed));
});
test('disconnected fetch has a bounded retry budget and recovers on hourly refresh',async()=>{
  const h=boot(false); h.sample(); await h.advance(120000);
  assert.equal(h.eval('state.status'),'offline'); assert.equal(h.requests.length,0); assert.equal(h.timers.size,0);
  h.context.watch.connected.pebblekit=true; h.events.hourchange(); await h.respond(valid());
  assert.equal(h.eval('state.status'),'ready');
});
test('hung fetch times out and ignores late responses after retry success',async()=>{
  const h=boot(); h.sample(); const old=h.requests[0];
  await h.advance(30000); assert.equal(h.requests.length,2);
  await h.respond(valid()); old.resolve({ok:true,json:async()=>({current:{temperature_2m:99,weather_code:0}})}); await h.flush();
  assert.equal(h.eval('state.weather.tempF'),21); assert.equal(h.timers.size,0);
});
test('superseded fetch cannot overwrite a newer forecast',async()=>{
  const h=boot(); h.sample(); const old=h.requests[0];
  h.events.hourchange(); h.sample(); await h.respond(valid()); old.resolve({ok:true,json:async()=>({current:{temperature_2m:99,weather_code:0}})}); await h.flush();
  assert.equal(h.eval('state.weather.tempF'),21); assert.equal(h.timers.size,0);
});
test('cached weather is visibly stale on refresh failure and age expiry',async()=>{
  const h=boot(); h.sample(); await h.respond(valid());
  h.events.hourchange(); h.requests.at(-1).reject(Error('offline')); await h.flush();
  assert.equal(h.eval('state.status'),'stale'); assert.ok(h.texts.some(t=>t.includes('STALE')));
  await h.advance(10000); await h.respond(valid());
  assert.equal(h.eval('state.status'),'ready');
  await h.advance(7200000); h.events.minutechange({date:new h.context.Date()});
  assert.equal(h.eval('state.status'),'stale');
});
test('daily selection follows location calendar day across UTC midnight',async()=>{
  const h=boot(); await h.advance(13*3600000); // Sept 10 01:00 UTC is Sept 9 in Austin.
  const sec=Date.UTC(2026,8,9)/1000;
  h.context.data={...valid(),utc_offset_seconds:-18000,daily:{time:[sec+18000,sec+104400],sunrise:[sec+39600,sec+126000],sunset:[sec+86400,sec+172800]}};
  assert.equal(h.eval('parseWeather(data).sunrise.getTime()'),(sec+39600)*1000);
  // The opposite date boundary in UTC+14 must also select the local day.
  h.context.data={...valid(),utc_offset_seconds:50400,daily:{time:[sec-50400,sec+36000],sunrise:[sec-28800,sec+57600],sunset:[sec+14400,sec+100800]}};
  assert.equal(h.eval('parseWeather(data).sunrise.getTime()'),(sec+57600)*1000);
});
test('HTTP and malformed JSON failures exhaust only one retry',async()=>{
  const h=boot(); h.sample();
  h.requests[0].resolve({ok:false,status:503}); await h.flush();
  assert.equal(h.eval('state.status'),'offline');
  assert.ok(h.texts.includes('--F  OFFLINE'));
  await h.advance(10000); await h.respond({current:{temperature_2m:20}});
  await h.advance(120000);
  assert.equal(h.requests.length,2); assert.equal(h.timers.size,0); assert.equal(h.eval('state.weather'),null);
});
test('hung response body times out through the entire bounded cycle',async()=>{
  const h=boot(); h.sample();
  h.requests[0].resolve({ok:true,json:()=>new Promise(()=>{})}); await h.flush();
  await h.advance(120000);
  assert.equal(h.requests.length,2); assert.equal(h.timers.size,0); assert.equal(h.eval('state.status'),'offline');
});
test('reconnection during the bounded wait fetches exactly once',async()=>{
  const h=boot(false); h.sample(); await h.advance(5000);
  h.context.watch.connected.pebblekit=true; await h.advance(1000); await h.respond(valid());
  await h.advance(120000); assert.equal(h.requests.length,1); assert.equal(h.timers.size,0);
});
test('throwing location sample and constructor both settle with bounded retries',async()=>{
  const h=boot(); h.sensors[0].sample=()=>{throw Error('sensor');}; h.sample();
  assert.equal(h.eval('state.status'),'offline'); assert.equal(h.sensors[0].closed,true);
  h.context.Location=class {constructor(){throw Error('permission');}};
  await h.advance(120000); assert.equal(h.timers.size,0); assert.equal(h.eval('state.status'),'offline');
});
test('globe recenters on GPS',()=>{
  const h=boot();
  const before=h.eval('viewOrigin()');
  assert.equal(before.lon,-90); assert.equal(before.lat,15);
  h.sample();
  const origin=h.eval('viewOrigin()');
  assert.equal(origin.lon,-97); assert.equal(origin.lat,30);
  const p=h.eval('(()=>{const o=viewOrigin(); const lat0=o.lat*Math.PI/180; return unprojectGlobe(GLOBE_CX,GLOBE_CY,o.lon*Math.PI/180,Math.sin(lat0),Math.cos(lat0));})()');
  assert.ok(Math.abs(p.lat-30)<3);
  assert.ok(Math.abs(p.lon+97)<3);
});
test('globe tilt is clamped and the pin stays at true latitude',()=>{
  const north=boot();
  north.sensors.at(-1).emit({latitude:80,longitude:10});
  const origin=north.eval('viewOrigin()');
  assert.equal(origin.lat,40); assert.equal(origin.lon,10);
  const pin=north.eval('(()=>{const o=viewOrigin(); const lat0=o.lat*Math.PI/180; return projectGlobe(state.lon,state.lat,o.lon*Math.PI/180,Math.sin(lat0),Math.cos(lat0));})()');
  assert.ok(pin); assert.ok(pin.y<north.eval('GLOBE_CY'));
  const south=boot();
  south.sensors.at(-1).emit({latitude:-75,longitude:20});
  const so=south.eval('viewOrigin()');
  assert.equal(so.lat,-40); assert.equal(so.lon,20);
});
module.exports={boot,valid};
