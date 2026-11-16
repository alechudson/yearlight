# Yearlight

A Pebble Time 2 and Pebble Round 2 watchface: sunlight moving across a location-centered globe,
with a large clock, date, local weather, and a day/night progress ruler.

**[Get it on the Pebble Appstore](https://apps.repebble.com/d58b889bab2c41cdb5a1b267)**

Bug reports and ideas are welcome in [Issues](https://github.com/alechudson/yearlight/issues).

The **Daylight** layout keeps the globe and year stars unchanged:
- Black ruler and marker: sunrise → sunset.
- Black ruler and crescent marker: sunset → next sunrise, continuing across midnight.
- The endpoint labels switch with the phase and use the forecast location's time offset.
- Time follows the watch's 12/24-hour setting; temperatures are Fahrenheit.
- `!` marks stale weather. Missing solar endpoints leave the ruler unfilled with `--:--` labels.

The phone requests yesterday through tomorrow's solar events, so a
fresh launch before dawn can locate the start of the night without guessing.

No branding chrome — just the planet, the time, and the sky where you are.

The on-watch and store name is **Yearlight** (`displayName` in `package.json`).
The UUID is unchanged so an already-installed build updates in place.

## Appstore

Live at <https://apps.repebble.com/d58b889bab2c41cdb5a1b267>. To ship an update,
bump `version` in `package.json`, then:

```sh
pebble clean && pebble publish --is-published --no-gif-all-platforms \
  --release-notes "What changed"
```

`pebble clean` matters: an incremental build can keep a stale `appinfo.json`
version. `--no-gif-all-platforms` keeps the time-lapse GIF on the listing instead
of replacing it with a one-minute capture.

### Rebuild the listing GIFs

`store/yearlight-emery.gif` is 200 × 228. `store/yearlight-gabbro.gif` is 260 × 260. Each one is a London day, 0.7 seconds a frame, looping. The sun and the day/night ruler move from pre-dawn through sunrise, morning, noon, afternoon, sunset, dusk, and night. Themes stay for two frames each, in order: classic, black, white, gray, black-gray.

`scripts/make-store-gif.sh` installs the face on the emulator, puts the phone in London, and saves each theme from the phone settings page. On these boards `pebble emu-set-time` does not move the face, because the face follows the clock inside the emulator. The script sets that clock and restarts the emulator for each frame. The frames use yesterday's date, which keeps the forecast from being marked stale while the clock steps through the day.

You need the Pebble SDK, Node, Chrome, ffmpeg, and libfaketime. From the repository root:

```sh
./scripts/make-store-gif.sh
```

The appstore accepts a PNG, JPEG, or GIF up to 4.4 MB. The script keeps each GIF under 1 MB. The palette is taken from the screenshots, so the captured theme colors are not shifted again.

## Building & running

```sh
pebble build                          # build for all targetPlatforms
pebble install --emulator emery       # install on the emery emulator
pebble install --phone <ip>           # install to a paired phone
```

## Target platforms

Targets **emery** (Pebble Time 2, 200 × 228) and **gabbro** (Pebble Round 2,
260 × 260). The round layout keeps the same sky-over-HUD stack with a larger
globe, HUD rows inset from the curved edge, and the year stars remapped into the
round sky. Platforms without Moddable XS (including the original Time Round,
chalk) are not supported.

```sh
pebble install --emulator gabbro
pebble screenshot --no-open --emulator gabbro screenshot_gabbro.png
```

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
