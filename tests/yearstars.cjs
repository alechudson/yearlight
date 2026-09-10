const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../src/embeddedjs/yearstars.js'), 'utf8').replace(/^export /gm, '');
const ctx = vm.createContext({Uint8Array, Date, Math});
vm.runInContext(source + '\nthis.STAR_N=STAR_N;this.STAR_X=STAR_X;this.STAR_Y=STAR_Y;this.STAR_SHAPE=STAR_SHAPE;this.dayOfYear=dayOfYear;this.litStarCount=litStarCount;this.isSeasonStar=isSeasonStar;', ctx);

const CX = 100, CY = 66, R = 64;

function inDisc(x, y, pad) {
  const dx = x + 0.5 - CX, dy = y + 0.5 - CY;
  return dx * dx + dy * dy <= (R + pad) * (R + pad);
}

test('catalog has 365 stars with valid shapes', () => {
  assert.equal(ctx.STAR_N, 365);
  assert.equal(ctx.STAR_X.length, 365);
  assert.equal(ctx.STAR_Y.length, 365);
  assert.equal(ctx.STAR_SHAPE.length, 365);
  for (let i = 0; i < 365; i++)
    assert.ok(ctx.STAR_SHAPE[i] <= 3);
});

test('stars sit in the map void, not on the globe', () => {
  for (let i = 0; i < 365; i++) {
    const x = ctx.STAR_X[i], y = ctx.STAR_Y[i];
    assert.ok(x >= 2 && x <= 197);
    assert.ok(y >= 2 && y <= 129);
    assert.equal(inDisc(x, y, 0), false);
    assert.equal(inDisc(x, y, 2), false);
  }
});

test('dayOfYear follows the local calendar, not UTC', () => {
  assert.equal(ctx.dayOfYear(new Date(2026, 0, 1, 0, 0, 0)), 1);
  assert.equal(ctx.dayOfYear(new Date(2026, 8, 9, 14, 39, 0)), 252);
  assert.equal(ctx.dayOfYear(new Date(2026, 11, 31, 23, 59, 0)), 365);
  assert.equal(ctx.dayOfYear(new Date(2028, 1, 29, 12, 0, 0)), 60);
  assert.equal(ctx.dayOfYear(new Date(2028, 11, 31, 12, 0, 0)), 366);
});

test('lit count is the day of year, clamped to 365', () => {
  assert.equal(ctx.litStarCount(new Date(2026, 0, 1)), 1);
  assert.equal(ctx.litStarCount(new Date(2026, 8, 9)), 252);
  assert.equal(ctx.litStarCount(new Date(2026, 11, 31)), 365);
  assert.equal(ctx.litStarCount(new Date(2028, 11, 31)), 365);
});

test('early-year stars are scattered, not a sector', () => {
  let left = 0, right = 0, top = 0, bottom = 0;
  for (let i = 0; i < 90; i++) {
    if (ctx.STAR_X[i] < 100) left++; else right++;
    if (ctx.STAR_Y[i] < 66) top++; else bottom++;
  }
  assert.ok(left > 20 && right > 20);
  assert.ok(top > 15 && bottom > 15);
});

test('season stars are the four solstice and equinox days', () => {
  const days = [];
  for (let i = 0; i < 365; i++)
    if (ctx.isSeasonStar(i, 2026)) days.push(i + 1);
  assert.deepEqual(days, [79, 172, 265, 355]);
  const leap = [];
  for (let i = 0; i < 365; i++)
    if (ctx.isSeasonStar(i, 2028)) leap.push(i + 1);
  assert.deepEqual(leap, [80, 173, 266, 356]);
});
