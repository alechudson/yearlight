"""Generate disposable, self-contained HUD concepts; no watch code changes."""
from pathlib import Path
from base64 import b64encode
import json

ROOT = Path(__file__).resolve().parent
SCREENSHOT = ROOT.parent.parent / 'screenshot_emery.png'
CONCEPTS = [
    dict(id='observatory', name='Observatory', tag='Quiet · centered · time first', stance='One centered stack, with nothing competing for attention.', choices='Full-width clock; dedicated date line; icon and temperature on their own line. White type, one yellow temperature accent. No weekly chart.', tradeoff='The cleanest everyday read, but gives up forecast detail.', best='A watch face, not a dashboard.'),
    dict(id='split-flap', name='Split-flap', tag='Architectural · asymmetric · organized', stance='Separate time, calendar, and weather into three deliberate zones.', choices='Clock across the left; a narrow weekday/date column on the right; a full-width inverted weather ribbon underneath. Stark black and white.', tradeoff='Fast scanning and strong structure; the weather ribbon is more visually assertive.', best='A distinctive digital-instrument look.'),
    dict(id='weather-deck', name='Weather deck', tag='Practical · weather first · bold', stance='Treat the lower section as a miniature weather instrument.', choices='Time and date form the header. An oversized yellow temperature is the hero below; a pixel icon, condition, and today’s high/low sit beside it.', tradeoff='The most useful outdoors, but time is smaller than in the other concepts.', best='Deciding what to wear or whether to head outside.'),
    dict(id='almanac', name='Almanac', tag='Calendar led · graphic · compact', stance='Make the calendar a graphic object rather than another caption.', choices='A cyan calendar tile anchors the left. Time and weather stack on the right. A small footer gives today’s high/low.', tradeoff='The date is unmistakable; less open black space and more visual structure.', best='Equal emphasis on date, time, and temperature.'),
    dict(id='daylight', name='Daylight', tag='Solar · contextual · restrained', stance='Connect the readout to the globe’s day/night story.', choices='A large centered clock, a date-and-weather row, and a compact daylight ruler from sunrise to sunset. A yellow marker shows time within the daylight interval.', tradeoff='Adds meaningful solar context, but replaces the weekly forecast. Browser mock uses illustrative sunrise/sunset times.', best='Making the whole face feel like one idea.'),
]

SCRIPT = r'''
const concepts = __CONCEPTS__;
const image = new Image();
const errors = [];
window.addEventListener('error', e => errors.push(e.message));
const P = {black:'#000000', white:'#ffffff', yellow:'#ffff00', cyan:'#00aaff', gray:'#aaaaaa'};
let variantState = 'clear';
let use24 = true;
let scale = 1;
const samples = {
 clear:{temp:'82°', condition:'CLEAR', hi:'89°', lo:'72°', icon:'sun', time:'18:30', short:'6:30', period:'PM', weekday:'WED', month:'SEP', day:'9', sunrise:'6:58', sunset:'7:43', progress:.9},
 rain:{temp:'68°', condition:'RAIN', hi:'74°', lo:'61°', icon:'rain', time:'08:05', short:'8:05', period:'AM', weekday:'MON', month:'NOV', day:'23', sunrise:'7:01', sunset:'5:31', progress:.1},
 wide:{temp:'104°', condition:'CLEAR', hi:'107°', lo:'81°', icon:'sun', time:'23:58', short:'11:58', period:'PM', weekday:'WED', month:'SEP', day:'30', sunrise:'6:58', sunset:'7:43', progress:1},
 off:{temp:'—°', condition:'NO DATA', hi:'—', lo:'—', icon:'off', time:'18:30', short:'6:30', period:'PM', weekday:'WED', month:'SEP', day:'9', sunrise:'—', sunset:'—', progress:null}
};
function rect(c,x,y,w,h,color=P.white) {c.fillStyle=color;c.fillRect(x,y,w,h);}
function text(c,s,x,y,size=16,color=P.white,align='left',max=200) {
 c.fillStyle=color;c.textAlign=align;c.textBaseline='top';
 c.font=`700 ${size}px Arial, Helvetica, sans-serif`;
 c.fillText(s,x,y,max);
}
function icon(c,kind,x,y,size=20,color=P.white) {
 c.save();c.translate(x,y);c.scale(size/20,size/20);
 if(kind==='sun') {
  rect(c,7,5,6,10,color);rect(c,5,7,10,6,color);
  [[9,0,2,3],[9,17,2,3],[0,9,3,2],[17,9,3,2],[3,3,2,2],[15,3,2,2],[3,15,2,2],[15,15,2,2]].forEach(r=>rect(c,...r,color));
 } else if(kind==='rain') {
  rect(c,4,7,13,5,color);rect(c,7,3,7,9,color);rect(c,1,9,18,4,color);
  [[4,16,2,3],[9,15,2,3],[14,16,2,3]].forEach(r=>rect(c,...r,color));
 } else {
  rect(c,3,4,14,12,P.gray);rect(c,5,6,10,8,P.black);rect(c,5,9,10,2,P.gray);
 }
 c.restore();
}
function clock(c,d,x,y,size,align='left',width=200) {
 const value=use24?d.time:d.short;
 const extra=use24?0:19;
 text(c,value,x,y,size,P.white,align,width-extra);
 if(!use24) {
  c.font=`700 ${size}px Arial, Helvetica, sans-serif`;
  const measured=Math.min(c.measureText(value).width,width-extra);
  const left=align==='center'?x-measured/2:align==='right'?x-measured:x;
  text(c,d.period,left+measured+3,y+size-12,9,P.gray,'left',17);
 }
}
function quantize(c) {
 const pixels=c.getImageData(0,132,200,96);
 for(let i=0;i<pixels.data.length;i+=4) {
  pixels.data[i]=Math.round(pixels.data[i]/85)*85;
  pixels.data[i+1]=Math.round(pixels.data[i+1]/85)*85;
  pixels.data[i+2]=Math.round(pixels.data[i+2]/85)*85;
  pixels.data[i+3]=255;
 }
 c.putImageData(pixels,0,132);
}
function draw(canvas,id) {
 const c=canvas.getContext('2d');c.imageSmoothingEnabled=false;
 c.fillStyle=P.black;c.fillRect(0,0,200,228);
 c.drawImage(image,0,0,200,132,0,0,200,132);
 const d=samples[variantState];
 const date=`${d.weekday} ${d.month} ${d.day}`;
 if(id==='observatory') {
  clock(c,d,100,134,42,'center',180);
  text(c,date,100,181,16,P.white,'center');
  icon(c,d.icon,66,205,17,P.yellow);
  text(c,d.temp,91,203,22,P.yellow,'left',90);
 } else if(id==='split-flap') {
  clock(c,d,8,141,42,'left',143);
  rect(c,153,140,1,49,P.gray);
  text(c,d.weekday,177,140,11,P.white,'center');
  text(c,d.day,177,153,25,P.white,'center');
  text(c,d.month,177,178,10,P.gray,'center');
  rect(c,0,198,200,30,P.white);
  icon(c,d.icon,9,204,17,P.black);
  text(c,d.temp,35,200,25,P.black,'left',66);
  text(c,d.condition,192,207,12,P.black,'right',85);
 } else if(id==='weather-deck') {
  clock(c,d,8,136,30,'left',110);
  text(c,d.weekday,192,138,11,P.gray,'right');
  text(c,`${d.month} ${d.day}`,192,152,13,P.white,'right');
  text(c,d.temp,7,176,44,P.yellow,'left',113);
  icon(c,d.icon,124,177,20);
  text(c,d.condition,152,181,11,P.white,'left',44);
  text(c,`H ${d.hi}`,126,202,11,P.white);
  text(c,`L ${d.lo}`,126,215,11,P.gray);
 } else if(id==='almanac') {
  rect(c,6,140,49,76,P.cyan);
  text(c,d.weekday,30,144,12,P.black,'center');
  text(c,d.day,30,159,34,P.black,'center',45);
  text(c,d.month,30,201,11,P.black,'center');
  clock(c,d,65,140,37,'left',131);
  icon(c,d.icon,66,184,18);
  text(c,d.temp,91,180,24,P.white,'left',61);
  text(c,d.condition,194,189,9,P.gray,'right',45);
  text(c,`H ${d.hi}  /  L ${d.lo}`,65,210,12,P.gray,'left',130);
 } else if(id==='daylight') {
  clock(c,d,100,134,42,'center',180);
  text(c,date,9,181,14,P.white,'left',114);
  icon(c,d.icon,131,180,15);
  text(c,d.temp,193,179,18,P.yellow,'right',43);
  rect(c,13,205,174,1,P.gray);
  rect(c,13,202,1,7,P.white);rect(c,186,202,1,7,P.white);
  if(d.progress!==null) {
   const x=Math.round(13+174*d.progress);
   rect(c,13,205,x-13,1,P.yellow);
   rect(c,x-2,203,5,5,P.yellow);rect(c,x-1,202,3,7,P.yellow);
  }
  text(c,`RISE ${d.sunrise}`,10,213,10,P.gray,'left',88);
  text(c,`SET ${d.sunset}`,190,213,10,P.gray,'right',88);
 }
 quantize(c);
 canvas.dataset.state=variantState;
 canvas.setAttribute('aria-label',`${id}: ${use24?d.time:d.short+' '+d.period}, ${date}, ${d.temp}, ${d.condition}`);
}
function renderAll() {
 document.querySelectorAll('canvas[data-concept]').forEach(c=>draw(c,c.dataset.concept));
 document.querySelector('#status').textContent=`Illustrative ${samples[variantState].condition.toLowerCase()} state · ${use24?'24':'12'}-hour time · ${scale}× pixels`;
}
function setup() {
 document.querySelectorAll('[data-state]').forEach(b=>b.addEventListener('click',()=>{
  variantState=b.dataset.state;
  document.querySelectorAll('[data-state]').forEach(el=>el.setAttribute('aria-pressed',String(el===b)));
  renderAll();
 }));
 document.querySelector('#clock-toggle').addEventListener('click',e=>{use24=!use24;e.currentTarget.textContent=use24?'Try 12-hour':'Try 24-hour';renderAll();});
 document.querySelector('#scale-toggle').addEventListener('click',e=>{scale=scale===1?2:1;document.documentElement.style.setProperty('--screen-width',`${200*scale}px`);e.currentTarget.textContent=scale===1?'Enlarge 2×':'Actual pixels';renderAll();});
 image.onload=()=>{renderAll();document.body.dataset.ready='true';};
 image.onerror=()=>{errors.push('Globe image failed');document.querySelector('#status').textContent='Globe image failed to load';};
 image.src='__IMAGE__';
}
setup();
'''
STYLE = '''
:root { --screen-width:200px; }
* {box-sizing:border-box;}
body { color:var(--foreground,#eee); }
main {padding:12px 0;}
h1 {font-size:20px;line-height:1.2;margin:0 0 8px;letter-spacing:-.4px;}
p {line-height:1.5;}
.lead {font-size:13px;color:var(--muted-foreground,#aaa);max-width:760px;margin:0 0 16px;}
.controls {display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin-bottom:8px;}
button {font:inherit;font-size:12px;min-height:44px;padding:8px 12px;border:1px solid var(--border,#444);border-radius:7px;color:var(--foreground,#eee);background:var(--card,#171717);cursor:pointer;}
button:hover {border-color:var(--accent,#00aaff);}
button[aria-pressed=true] {border-color:var(--foreground,#eee);font-weight:700;}
button:focus-visible {outline:2px solid var(--accent,#00aaff);outline-offset:2px;}
#status {font-size:11px;color:var(--muted-foreground,#aaa);margin:0 0 20px;}
.grid {display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,calc(var(--screen-width) + 24px)),max-content));gap:26px 18px;align-items:start;}
article {width:min(calc(var(--screen-width) + 24px),100%);min-width:0;}
.number {font-size:10px;font-weight:700;color:var(--muted-foreground,#aaa);letter-spacing:1.4px;margin-bottom:5px;}
h2 {font-size:17px;line-height:1.25;margin:0 0 4px;}
.tag {color:var(--muted-foreground,#aaa);font-size:11px;margin:0 0 15px;}
canvas {display:block;width:min(var(--screen-width),100%);height:auto;aspect-ratio:200/228;background:#000;image-rendering:pixelated;outline:1px solid var(--border,#444);}
.description {font-size:12px;margin:12px 0 7px;max-width:360px;}
.tradeoff {color:var(--muted-foreground,#aaa);font-size:11px;margin:0;max-width:360px;}
.foot {font-size:11px;color:var(--muted-foreground,#aaa);margin:24px 0 0;max-width:760px;}
'''
CONTROLS = '''<div class="controls" aria-label="Sample state controls">
<button data-state="clear" aria-pressed="true">Clear</button><button data-state="rain" aria-pressed="false">Rain</button><button data-state="wide" aria-pressed="false">Wide values</button><button data-state="off" aria-pressed="false">No weather</button><button id="clock-toggle">Try 12-hour</button><button id="scale-toggle">Enlarge 2×</button></div><p id="status" role="status">Loading mockups…</p>'''

def card(c, index):
    return f'''<article><div class="number">CONCEPT {index:02d}</div><h2>{c['name']}</h2><p class="tag">{c['tag']}</p><canvas width="200" height="228" data-concept="{c['id']}" role="img"></canvas><p class="description">{c['stance']}</p><p class="tradeoff">{c['tradeoff']}</p></article>'''

def page(selected, standalone=False):
    image = 'data:image/png;base64,' + b64encode(SCREENSHOT.read_bytes()).decode()
    script = SCRIPT.replace('__CONCEPTS__', json.dumps(CONCEPTS)).replace('__IMAGE__', image)
    wrapper = 'body {margin:0;padding:24px;font-family:system-ui,sans-serif;background:#101011;color:#eee;}' if standalone else ''
    cards = ''.join(card(c, CONCEPTS.index(c)+1) for c in selected)
    return f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Five Pebble HUD concepts</title><style>{STYLE}{wrapper}</style></head><body><main><h1>Five directions for the lower section</h1><p class="lead">Same globe. Five different information hierarchies. Each face is drawn at 200 × 228; only the bottom 96 pixels change.</p>{CONTROLS}<div class="grid">{cards}</div><p class="foot">Design studies only—not installed. Sample weather and solar times are illustrative. The globe is preserved from the existing emulator screenshot; browser typography approximates device fonts. Controls compare mock states, not watch interactions.</p></main><script>{script}</script></body></html>'''

ROOT.mkdir(parents=True, exist_ok=True)
(ROOT / 'index.html').write_text(page(CONCEPTS))
(ROOT / 'standalone.html').write_text(page(CONCEPTS, True))
for c in CONCEPTS:
    path = ROOT / c['id']
    path.mkdir(exist_ok=True)
    (path / 'index.html').write_text(page([c], True))
    (path / 'README.md').write_text(f"# {c['name']}\n\n## Design stance\n{c['stance']}\n\n## Key choices\n{c['choices']}\n\n## Trade-offs\n{c['tradeoff']}\n\n## Best for\n{c['best']}\n\n## Interaction\nSwitch clear/rain/wide/no-weather samples; compare 12/24-hour time and native/2× pixels. These are browser-only controls.\n")
(ROOT / 'README.md').write_text('# Lower-section concepts\n\nFive disposable design studies. Production source is unchanged.\n\nOpen `standalone.html` in a browser, or `index.html` in the Hermes inline preview. Individual concepts have standalone pages.\n\nAll sample readings are illustrative. Globe pixels are reused unchanged from the repository screenshot. Device fonts need an actual Emery pass before choosing final sizes.\n\nRegenerate with `python3 build_concepts.py`.\n')
(ROOT / 'concepts.json').write_text(json.dumps(CONCEPTS, indent=2))
print(json.dumps({'concept_count':len(CONCEPTS),'gallery':str(ROOT / 'index.html'),'standalone':str(ROOT / 'standalone.html'),'variants':[c['id'] for c in CONCEPTS]}, indent=2))
