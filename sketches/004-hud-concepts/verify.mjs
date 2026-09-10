import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const tabs=await (await fetch('http://127.0.0.1:19473/json')).json();
const tab=tabs.find(t=>t.type==='page');
assert.ok(tab,'Chrome page target ready');
const ws=new WebSocket(tab.webSocketDebuggerUrl);
let id=0;const pending=new Map();const pageErrors=[];
ws.onmessage=e=>{
 const m=JSON.parse(e.data);
 if(m.id&&pending.has(m.id)) {const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);}
 if(m.method==='Runtime.exceptionThrown')pageErrors.push(m.params.exceptionDetails);
 if(m.method==='Log.entryAdded'&&m.params.entry.level==='error')pageErrors.push(m.params.entry);
 if(m.method==='Runtime.consoleAPICalled'&&m.params.type==='error')pageErrors.push(m.params.args);
};
await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
function send(method,params={}) {const n=++id;return new Promise((resolve,reject)=>{pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}));});}
async function evaluate(expression) {const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;}
async function ready() {for(let n=0;n<50;n++){if(await evaluate('document.body?.dataset.ready === "true"'))return;await new Promise(r=>setTimeout(r,100));}throw new Error('Page not ready');}
async function shot(name,full=false) {
 const params={format:'png',captureBeyondViewport:full};
 if(full){const m=await send('Page.getLayoutMetrics');params.clip={x:0,y:0,width:m.cssContentSize.width,height:m.cssContentSize.height,scale:1};}
 const s=await send('Page.captureScreenshot',params);fs.writeFileSync(path.join(root,name),Buffer.from(s.data,'base64'));
}
await send('Runtime.enable');await send('Log.enable');await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride',{width:1240,height:800,deviceScaleFactor:1,mobile:false});
await send('Page.navigate',{url:'file://'+path.join(root,'standalone.html')});await ready();
assert.equal(await evaluate('document.querySelectorAll("canvas[data-concept]").length'),5);
assert.equal(await evaluate('errors.length'),0);
await shot('concepts-desktop.png');
const variants=JSON.parse(fs.readFileSync(path.join(root,'concepts.json')));
assert.equal(new Set(variants.map(v=>v.id)).size,5);
const checks=[];
for(const state of ['rain','wide','off','clear']) {
 await evaluate(`document.querySelector('[data-state="${state}"]').click()`);
 assert.deepEqual(await evaluate('[...document.querySelectorAll("canvas")].map(c=>c.dataset.state)'),Array(5).fill(state));
 const labels=await evaluate('[...document.querySelectorAll("canvas")].map(c=>c.getAttribute("aria-label"))');
 if(state==='off') assert.ok(labels.every(l=>l.includes('NO DATA')));
 if(state==='wide') {await evaluate('document.querySelector("#clock-toggle").click()');assert.ok((await evaluate('[...document.querySelectorAll("canvas")].map(c=>c.getAttribute("aria-label"))')).every(l=>l.includes('11:58 PM')));await shot('concepts-wide-12h.png');await evaluate('document.querySelector("#clock-toggle").click()');}
 checks.push({state,count:labels.length});
}
await evaluate('document.querySelector("#scale-toggle").click()');
assert.equal(await evaluate('Math.round(document.querySelector("canvas").getBoundingClientRect().width)'),400);
await shot('concepts-enlarged.png',true);
await evaluate('document.querySelector("#scale-toggle").click()');
for (const c of variants) {
 await send('Page.navigate',{url:'file://'+path.join(root,c.id,'index.html')});await ready();
 assert.equal(await evaluate('document.querySelectorAll("canvas").length'),1);
 const data=await evaluate('document.querySelector("canvas").toDataURL("image/png")');
 fs.writeFileSync(path.join(root,c.id,'face.png'),Buffer.from(data.split(',')[1],'base64'));
}
await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
await send('Page.navigate',{url:'file://'+path.join(root,'standalone.html')});await ready();
assert.ok(await evaluate('document.body.scrollWidth<=innerWidth'));
assert.ok(await evaluate('[...document.querySelectorAll("button")].every(b=>b.getBoundingClientRect().height>=44)'));
await shot('concepts-mobile.png',true);
await evaluate('document.querySelector("#scale-toggle").click()');
assert.ok(await evaluate('document.body.scrollWidth<=innerWidth'));
await shot('concepts-mobile-enlarged.png',true);
await send('Emulation.setDeviceMetricsOverride',{width:780,height:900,deviceScaleFactor:1,mobile:false});
await send('Page.navigate',{url:'file://'+path.join(root,'index.html')});await ready();
assert.equal(await evaluate('document.querySelectorAll("canvas").length'),5);
assert.ok(await evaluate('document.body.scrollWidth<=innerWidth'));
await shot('concepts-inline.png',true);
assert.deepEqual(pageErrors,[]);
const result={pass:true,conceptCount:variants.length,states:checks,clockModes:['24h','12h'],scaleModes:['native','2x'],viewports:['1240x800','390x844','780x900'],pageErrors,screenshots:['concepts-desktop.png','concepts-wide-12h.png','concepts-enlarged.png','concepts-mobile.png','concepts-mobile-enlarged.png','concepts-inline.png']};
fs.writeFileSync(path.join(root,'verification.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify(result,null,2));ws.close();
