# Day Night

A Pebble Time 2 watchface: sunlight moving across a world map, with local
weather, a 6-hour precip strip, and sunrise / sunset.

No branding chrome — just the planet, the time, and the sky where you are.

Weather comes from [Open-Meteo](https://open-meteo.com) via the phone GPS.

## Building & running

```sh
pebble build                          # build for all targetPlatforms
pebble install --emulator emery       # install on the emery emulator
pebble install --phone <ip>           # install to a paired phone
```

## Target platforms

Day Night targets **emery** (Pebble Time 2, 200 × 228). Other platforms are
currently not supported.

## Stability checks

```sh
node --test tests/*.cjs       # deterministic host-side regressions
pebble build                 # compile the actual Moddable/Emery bundle
pebble install --emulator emery
pebble screenshot --no-open --emulator emery screenshot_emery.png
```

Host-side tests exercise the watch JavaScript with mocked hardware boundaries;
they do not replace an emulator run or paired-phone testing. Before treating a
build as a daily-driver release, test location permission denial, Bluetooth
reconnection, a day rollover, and battery use on a real watch. The solar shading
is an approximation, not a navigation or astronomical instrument.

## Project layout

```
src/c/mdbl.c                   C glue around the Moddable runtime
src/embeddedjs/main.js         JavaScript that runs on the watch
src/embeddedjs/manifest.json   Moddable manifest
src/pkjs/index.js              PebbleKit JS (phone-side) code
package.json                   Project metadata (UUID, platforms, resources)
wscript                        Build rules — usually no need to edit
```

## Documentation

Full SDK docs and tutorials: <https://developer.repebble.com>
