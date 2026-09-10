const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
function boot() {
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
  const mask = fs.readFileSync(path.join(__dirname,'../src/embeddedjs/worldmask.js'),'utf8').replace(/^export /gm,'');
  vm.runInContext(mask, context);
  const stars = fs.readFileSync(path.join(__dirname,'../src/embeddedjs/yearstars.js'),'utf8').replace(/^export /gm,'');
  vm.runInContext(stars, context);
  const source = fs.readFileSync(path.join(__dirname,'../src/embeddedjs/main.js'),'utf8').replace(/^import .*;\r?\n/gm,'');
  vm.runInContext(source,context);
  return {context,events,timers,texts,messages, eval:code=>vm.runInContext(code,context),
    async flush(){for(let i=0;i<8;i++) await Promise.resolve();},
    async advance(ms){const end=now+ms; let count=0; while(true){const next=[...timers].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0]; if(!next)break; if(++count>1000)throw Error('unbounded timers'); now=next[1].at; timers.delete(next[0]); next[1].fn(); await this.flush();} now=end;},
    deliver(data){messages[0].deliver(typeof data==='string'?data:JSON.stringify(data));}};
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
      assert.notEqual(h.eval('parseWeather(data)'),null);
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
  assert.ok(h.texts.includes('21F  CLOUD'));
});
test('payload parser uses UTC seconds with the matching daily entry', ()=>{
  const h=boot();
  const sec=Date.UTC(2026,8,9)/1000;
  h.deliver(wx({...valid(), daily:{time:[sec-86400,sec,sec+86400],temperature_2m_max:[99,91,88],temperature_2m_min:[50,72,68],sunrise:[sec-64800,sec+21600,sec+108000],sunset:[sec-21600,sec+64800,sec+151200]}}));
  assert.equal(h.eval('state.weather.days.length'),2);
  assert.equal(h.eval('state.weather.days[0].hi'),91);
  assert.equal(h.eval('state.weather.days[0].lo'),72);
  assert.equal(h.eval('state.weather.sunrise.getTime()'),(sec+21600)*1000);
});
test('daily highs and lows start at the location calendar day and skip invalid samples',()=>{
  const h=boot();
  const sec=Date.UTC(2026,8,9)/1000;
  h.context.data={...valid(),daily:{time:[sec-86400,sec,sec+86400,sec+2*86400,sec+3*86400,sec+4*86400,sec+5*86400,sec+6*86400],temperature_2m_max:[80,81,82,83,NaN,85,86,87],temperature_2m_min:[60,61,70,62,63,64,65,66]}};
  const days=h.eval('parseWeather(data).days');
  assert.equal(days.length,6);
  assert.equal(days[0].hi,81);
  assert.equal(days[2].hi,83);
  assert.equal(days[3].hi,85);
  h.context.data={...valid(),daily:{time:[sec],temperature_2m_max:[20],temperature_2m_min:[30]}};
  assert.equal(h.eval('parseWeather(data).days.length'),0);
});
test('parser rejects invalid current data and omits invalid optional samples',()=>{
  const h=boot();
  for(const value of [NaN,Infinity,null,'20']) { h.context.data={current:{temperature_2m:value,weather_code:1}}; assert.equal(h.eval('parseWeather(data)'),null); }
  for(const code of [undefined,null,NaN,Infinity,-1,4,100,'1']) { h.context.data={current:{temperature_2m:20,weather_code:code}}; assert.equal(h.eval('parseWeather(data)'),null); }
  const sec=Date.UTC(2026,8,9)/1000;
  h.context.data={...valid(),daily:{time:[sec],sunrise:[null],sunset:['bad'],temperature_2m_max:[null],temperature_2m_min:[0]}};
  assert.equal(h.eval('parseWeather(data).days.length'),0);
  assert.equal(h.eval('parseWeather(data).sunrise'),null);
  assert.equal(h.eval('parseWeather(data).sunset'),null);
  h.context.data={...valid()};
  assert.equal(h.eval('parseWeather(data).days.length'),0);
});
test('bad payload and missing location stay offline',()=>{
  const h=boot();
  h.deliver({error:1});
  assert.equal(h.eval('state.status'),'offline');
  assert.equal(h.eval('state.lat'),null);
  assert.ok(h.texts.includes('--F  NO LOC'));
  h.deliver('{');
  assert.equal(h.eval('state.lat'),null);
  h.deliver({lat:91,lon:0,weather:valid()});
  assert.equal(h.eval('state.lat'),null);
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
  assert.ok(h.texts.includes('--F  NO LOC'));
});
test('hourly refresh writes CMD once the phone is writable',()=>{
  const h=boot();
  h.events.hourchange();
  assert.equal(h.messages[0].sent,undefined);
  h.eval('phoneWritable=true');
  h.events.hourchange();
  assert.equal(h.messages[0].sent.get('CMD'),1);
});
test('cached weather is visibly stale on error payload and age expiry',async()=>{
  const h=boot(); h.deliver(wx());
  h.deliver({error:1});
  assert.equal(h.eval('state.status'),'stale'); assert.ok(h.texts.some(t=>t.includes('STALE')));
  h.deliver(wx());
  assert.equal(h.eval('state.status'),'ready');
  await h.advance(7200000); h.events.minutechange({date:new h.context.Date()});
  assert.equal(h.eval('state.status'),'stale');
});
test('daily selection follows location calendar day across UTC midnight',()=>{
  const h=boot();
  const sec=Date.UTC(2026,8,9)/1000;
  h.context.data={...valid(),utc_offset_seconds:-18000,daily:{time:[sec+18000,sec+104400],sunrise:[sec+39600,sec+126000],sunset:[sec+86400,sec+172800]}};
  assert.equal(h.eval('parseWeather(data).sunrise.getTime()'),(sec+39600)*1000);
  h.context.data={...valid(),utc_offset_seconds:50400,daily:{time:[sec-50400,sec+36000],sunrise:[sec-28800,sec+57600],sunset:[sec+14400,sec+100800]}};
  assert.equal(h.eval('parseWeather(data).sunrise.getTime()'),(sec+57600)*1000);
});
test('globe recenters on payload location',()=>{
  const h=boot();
  const before=h.eval('viewOrigin()');
  assert.equal(before.lon,-90); assert.equal(before.lat,15);
  h.deliver(wx());
  const origin=h.eval('viewOrigin()');
  assert.equal(origin.lon,-97); assert.equal(origin.lat,30);
  const p=h.eval('(()=>{const o=viewOrigin(); const lat0=o.lat*Math.PI/180; return unprojectGlobe(GLOBE_CX,GLOBE_CY,o.lon*Math.PI/180,Math.sin(lat0),Math.cos(lat0));})()');
  assert.ok(Math.abs(p.lat-30)<3);
  assert.ok(Math.abs(p.lon+97)<3);
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
module.exports={boot,valid,wx};
