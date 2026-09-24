// Shared by the watch-side tests: encodes phone data with the real pkjs wire format.
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const context = vm.createContext({
	Pebble: {addEventListener() {}, sendAppMessage() {}},
	localStorage: {getItem() { return null; }, setItem() {}},
	navigator: {}, console: {log() {}}, setTimeout() {}, XMLHttpRequest: class {},
	JSON, Math, Date, isFinite, Array, String,
});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/pkjs/index.js'), 'utf8'), context);

module.exports = function wire(data) {
	return typeof data === 'string' ? data : context.wirePayload(data);
};
