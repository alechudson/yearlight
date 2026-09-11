# Yearlight

A Pebble Time 2 watchface: sunlight moving across a location-centered globe,
with a large clock, date, local weather, and a day/night progress ruler.

The **Daylight** layout keeps the globe and year stars unchanged:
- Black ruler and marker: sunrise → sunset.
- Muted-blue ruler and crescent marker: sunset → next sunrise, continuing across midnight.
- The endpoint labels switch with the phase and use the forecast location's time offset.
- Time follows the watch's 12/24-hour setting; temperatures are Fahrenheit.
- `!` marks stale weather. Missing solar endpoints leave the ruler unfilled with `--:--` labels.

The phone requests yesterday through tomorrow's solar events, so a
fresh launch before dawn can locate the start of the night without guessing.

No branding chrome — just the planet, the time, and the sky where you are.

The on-watch and store name is **Yearlight** (`displayName` in `package.json`).
The UUID is unchanged so an already-installed build updates in place.

## Appstore (not published yet)

The listing is created later with `pebble login` then `pebble publish`. Until
then, sideload with `pebble install`. Before the first upload:

- Capture Emery shots named `emery_*.png` from a daily-driver build, not perf artifacts.
- Wear it through location denial, Bluetooth drop, overnight rollover, and battery.

```sh
pebble screenshot --no-open --emulator emery emery_day.png
pebble publish --release-notes "First public release"
```

Omit `--is-published` to create the listing without making it public. Bump
`version` in `package.json` for every later release.

## Building & running

```sh
pebble build                          # build for all targetPlatforms
pebble install --emulator emery       # install on the emery emulator
pebble install --phone <ip>           # install to a paired phone
```

## Target platforms

Targets **emery** (Pebble Time 2, 200 × 228). Other platforms are currently
not supported.

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

## Credits

Inspired by Ren Gianforte's [Day and Night Earth](https://apps.repebble.com/day-and-night-earth-watchface_530bd23d3add7beccc0001e3) watchface ([source](https://github.com/rengianforte/pebble-day-night)). This is a separate implementation, not a fork.

[Weather data by Open-Meteo.com](https://open-meteo.com/) (CC BY 4.0). Globe geography is made with [Natural Earth](https://www.naturalearthdata.com/). Solar position follows [NOAA GML](https://gml.noaa.gov/grad/solcalc/) calculations.

Full notices are in [CREDITS.md](CREDITS.md).
