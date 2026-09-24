const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const wire = require('./wire.cjs');
function boot(store) {
  let now = Date.UTC(2026, 8, 9, 12), serial = 0;
  const timers = new Map(), events = {}, texts = [], messages = [];
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  class Poco { constructor() { this.Font = class {}; this.unobstructed = {width:200,height:228}; } makeColor(){return 0;} begin(){} end(){} fillRectangle(){} drawBitmap(){} drawLine(){} drawText(text){texts.push(text);} getTextWidth(){return 0;} }
  Poco.PebbleBitmap = class {};
  class Message {
    constructor(options) { this.options=options; messages.push(this); }
    write(map){ this.sent=map; }
    read(){ return this._msg; }
    deliver(payload){
      this._msg={get(key){return key==='PAYLOAD'?payload:undefined;}};
      this.options.onReadable.call(this);
    }
  }
  const context = vm.createContext({Poco, Message, screen:{}, Date:Clock, console:{log(){}},
    watch:{hour12:false, connected:{pebblekit:true}, addEventListener(name, fn){events[name]=fn;}},
    setTimeout(fn, delay){const id=++serial; timers.set(id,{fn, at:now+delay}); return id;}, clearTimeout(id){timers.delete(id);}});
  if (store) context.localStorage={getItem(k){return store.has(k)?store.get(k):null;}, setItem(k,v){store.set(k,String(v)); store.writes=(store.writes||0)+1;}};
  context.fields = () => wire({lat:30, lon:-97, weather:context.data}).split(',');
  const mask = fs.readFileSync(path.join(__dirname,'../src/embeddedjs/worldmask.js'),'utf8').replace(/^export /gm,'');
  vm.runInContext(mask, context);
  const stars = fs.readFileSync(path.join(__dirname,'../src/embeddedjs/yearstars.js'),'utf8').replace(/^export /gm,'');
  vm.runInContext(stars, context);
  const source = fs.readFileSync(path.join(__dirname,'../src/embeddedjs/main.js'),'utf8').replace(/^import .*;\r?\n/gm,'');
  vm.runInContext(source,context);
  return {context,events,timers,texts,messages, eval:code=>vm.runInContext(code,context),
    async flush(){for(let i=0;i<8;i++) await Promise.resolve();},
    async advance(ms){const end=now+ms; let count=0; while(true){const next=[...timers].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0]; if(!next)break; if(++count>1000)throw Error('unbounded timers'); now=next[1].at; timers.delete(next[0]); next[1].fn(); await this.flush();} now=end;},
    deliver(data){messages[0].deliver(wire(data));}};
}
const valid = () => ({current:{temperature_2m:21.4,weather_code:1}});
const wx = (weather=valid(), lat=30, lon=-97) => ({lat, lon, weather});
const moodGroups = {
  CLEAR:[0], CLOUD:[1,2,3], FOG:[45,48], DRIZL:[51,53,55,56,57],
  RAIN:[61,63,65,66,67], SNOW:[71,73,75,77,85,86], SHWR:[80,81,82], STORM:[95,96,99]
};
for (const [mood,codes] of Object.entries(moodGroups)) {
  for (const code of codes) {
    test(`accepted WMO code ${code} has mood ${mood}`,()=>{
      const h=boot();
      h.context.data={current:{temperature_2m:20,weather_code:code}};
      assert.notEqual(h.eval('parseWeather(fields())'),null);
      assert.equal(h.eval(`moodFor(${code})`),mood);
    });
  }
}
test('phone payload sets location and weather', ()=>{
  const h=boot();
  assert.equal(h.eval('state.lat'),null);
  h.deliver(wx());
  assert.equal(h.eval('state.status'),'ready');
  assert.equal(h.eval('state.lat'),30);
  assert.equal(h.eval('state.lon'),-97);
  assert.ok(h.texts.includes('21°'));
});
test('payload parser uses UTC seconds with the matching daily entry', ()=>{
  const h=boot();
  const sec=Date.UTC(2026,8,9)/1000;
  h.deliver(wx({...valid(), daily:{time:[sec-86400,sec,sec+86400],sunrise:[sec-64800,sec+21600,sec+108000],sunset:[sec-21600,sec+64800,sec+151200]}}));
  assert.equal(h.eval('state.weather.solarDays.length'),3);
  assert.equal(h.eval('state.weather.solarDays[1].sunrise.getTime()'),(sec+21600)*1000);
});
test('parser rejects invalid current data and omits invalid optional samples',()=>{
  const h=boot();
  for(const value of [NaN,Infinity,null,'20']) { h.context.data={current:{temperature_2m:value,weather_code:1}}; assert.equal(h.eval('parseWeather(fields())'),null); }
  for(const code of [undefined,null,NaN,Infinity,-1,4,100,'1']) { h.context.data={current:{temperature_2m:20,weather_code:code}}; assert.equal(h.eval('parseWeather(fields())'),null); }
  const sec=Date.UTC(2026,8,9)/1000;
  h.context.data={...valid(),daily:{time:[sec],sunrise:[null],sunset:['bad']}};
  assert.equal(h.eval('parseWeather(fields()).solarDays[0].sunrise'),null);
  assert.equal(h.eval('parseWeather(fields()).solarDays[0].sunset'),null);
  h.context.data={...valid()};
  assert.equal(h.eval('parseWeather(fields()).solarDays.length'),0);
});
test('bad payload and missing location stay offline',()=>{
  const h=boot();
  h.deliver({error:1});
  assert.equal(h.eval('state.status'),'offline');
  assert.equal(h.eval('state.lat'),null);
  assert.ok(h.texts.includes('--°'));
  h.deliver('{');
  assert.equal(h.eval('state.lat'),null);
  h.deliver({lat:91,lon:0,weather:valid()});
  assert.equal(h.eval('state.lat'),null);
});
test('a cached payload older than two hours is already stale',()=>{
  const h=boot();
  const wxData=wx();
  wxData.updatedAt=Date.UTC(2026,8,9,9);
  h.deliver(wxData);
  assert.equal(h.eval('state.status'),'stale');
  assert.ok(h.texts.includes('21°!'));
});
test('location can land without a usable forecast',()=>{
  const h=boot();
  h.deliver({lat:30,lon:-97,weather:{}});
  assert.equal(h.eval('state.lat'),30);
  assert.equal(h.eval('state.status'),'offline');
});
test('silent phone times out instead of waiting forever',async()=>{
  const h=boot(); await h.advance(30000);
  assert.equal(h.eval('state.status'),'offline');
  assert.ok(h.texts.includes('--°'));
});
test('a default globe appears after two seconds if location has not arrived',async()=>{
  const h=boot();
  assert.equal(h.eval('globeDrawn.lon'),9999);
  await h.advance(2000);
  assert.equal(h.eval('state.status'),'loading');
  assert.notEqual(h.eval('globeDrawn.lon'),9999);
});
test('hourly refresh writes CMD once the phone is writable',()=>{
  const h=boot();
  h.events.hourchange();
  assert.equal(h.messages[0].sent,undefined);
  h.eval('phoneWritable=true');
  h.events.hourchange();
  assert.equal(h.messages[0].sent.get('CMD'),1);
});
test('cached weather stays ready on a failed refresh until it is two hours old',async()=>{
  const h=boot(); h.deliver(wx());
  h.deliver({error:1});
  assert.equal(h.eval('state.status'),'ready'); assert.ok(h.texts.includes('21°'));
  assert.ok(!h.texts.includes('21°!'));
  h.deliver(wx());
  assert.equal(h.eval('state.status'),'ready');
  await h.advance(7200000); h.events.minutechange({date:new h.context.Date()});
  assert.equal(h.eval('state.status'),'stale'); assert.ok(h.texts.includes('21°!'));
});
test('daily selection follows location calendar day across UTC midnight',()=>{
  const h=boot();
  const sec=Date.UTC(2026,8,9)/1000;
  h.context.data={...valid(),utc_offset_seconds:-18000,daily:{time:[sec+18000,sec+104400],sunrise:[sec+39600,sec+126000],sunset:[sec+86400,sec+172800]}};
  assert.equal(h.eval('parseWeather(fields()).solarDays[0].sunrise.getTime()'),(sec+39600)*1000);
  h.context.data={...valid(),utc_offset_seconds:50400,daily:{time:[sec-50400,sec+36000],sunrise:[sec-28800,sec+57600],sunset:[sec+14400,sec+100800]}};
  assert.equal(h.eval('parseWeather(fields()).solarDays[1].sunrise.getTime()'),(sec+57600)*1000);
});
test('globe recenters on payload location',()=>{
  const h=boot();
  const before=h.eval('viewOrigin()');
  assert.equal(before.lon,-90); assert.equal(before.lat,15);
  h.deliver(wx());
  const origin=h.eval('viewOrigin()');
  assert.equal(origin.lon,-97); assert.equal(origin.lat,30);
  const pin=h.eval('(()=>{const o=viewOrigin(); const lat0=o.lat*Math.PI/180; return projectGlobe(state.lon,state.lat,o.lon*Math.PI/180,Math.sin(lat0),Math.cos(lat0));})()');
  assert.ok(pin);
  assert.ok(Math.abs(pin.x-100)<=2);
  assert.ok(Math.abs(pin.y-66)<=3);
});
test('globe tilt is clamped and the pin stays at true latitude',()=>{
  const north=boot();
  north.deliver(wx(valid(),80,10));
  const origin=north.eval('viewOrigin()');
  assert.equal(origin.lat,40); assert.equal(origin.lon,10);
  const pin=north.eval('(()=>{const o=viewOrigin(); const lat0=o.lat*Math.PI/180; return projectGlobe(state.lon,state.lat,o.lon*Math.PI/180,Math.sin(lat0),Math.cos(lat0));})()');
  assert.ok(pin); assert.ok(pin.y<north.eval('GLOBE_CY'));
  const south=boot();
  south.deliver(wx(valid(),-75,20));
  const so=south.eval('viewOrigin()');
  assert.equal(so.lat,-40); assert.equal(so.lon,20);
});
test('the last good payload is stored once and restored on relaunch',async()=>{
  const store=new Map();
  const h=boot(store);
  h.deliver(wx());
  h.deliver(wx());
  h.deliver({error:1});
  assert.equal(store.writes,1,'unchanged and error payloads do not rewrite flash');
  const again=boot(store);
  assert.equal(again.eval('state.lat'),null,'the clock paints before storage is read');
  await again.advance(0);
  assert.equal(again.eval('state.lat'),30);
  assert.equal(again.eval('state.status'),'ready');
  assert.ok(again.texts.includes('21°'));
  assert.equal(store.writes,1);
});
test('a phone payload that beats the restore wins',async()=>{
  const store=new Map([['wx','10,20,,50,0,0']]);
  const h=boot(store);
  h.deliver(wx());
  await h.advance(0);
  assert.equal(h.eval('state.lat'),30);
});
module.exports={boot,valid,wx};
