const test = require('node:test');
const assert = require('node:assert/strict');
const {boot} = require('./weather.cjs');

function send(h, dict) {
  const message = h.messages[0];
  message._msg = {get(key) { return dict[key]; }};
  message.options.onReadable.call(message);
}

test('theme 4 is stored on the watch and restored with the phone disconnected', () => {
  const store = new Map();
  const h = boot(store);
  assert.equal(h.eval('THEMES.length'), 5);
  send(h, {THEME: 4});
  assert.equal(h.eval('theme === THEMES[4]'), true);
  assert.equal(store.get('th'), '4');
  const again = boot(store);
  assert.equal(again.eval('theme === THEMES[4]'), true);
  assert.equal(store.get('th'), '4');
});
