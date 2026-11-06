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
version. `--no-gif-all-platforms` keeps the day/night GIF on the listing instead
of replacing it with a one-minute capture.

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
round sky. Other platforms (including the original Time Round, chalk) have no
layout yet.

```sh
pebble install --emulator gabbro
pebble screenshot --no-open --emulator gabbro screenshot_gabbro.png
```

## Native C

The watch side is native C. Up to 1.2.0 it was Moddable JavaScript, which a
watchface pays for at every launch, and a watchface relaunches after every
notification and menu visit:

- **No engine to start.** The JavaScript face first built an XS machine (about
  56 KB of stack, slot and chunk pools) and loaded three modules.
- **No data to decode.** The land mask and year stars are `const` tables in
  flash (`src/c/worldmask.c`, `src/c/yearstars.c`). XS indexes strings by
  walking them, so the old hex decode walked about 15 million bytes per launch.
- **Integer math where it repeats.** Watch apps build for a Cortex-M3 with no
  FPU, so every float operation is a library call. The globe's 3,228 samples
  (3,852 on Round 2) use integer square roots and a fixed-point `atan2`:
  positions in 1/256 px, angles in binary turns. Doubles are left for the
  handful of sun and sunrise calculations per redraw.
- **Shading cached.** Land is projected once per place. Day and night are
  shaded once per half hour (or theme, quick view or new day), and each frame
  replays the result as runs of `graphics_fill_rect`.

The Round 2 star lattice is baked into `yearstars.c` by
`scripts/gen-round-stars.cjs --write`, and `scripts/gen_globe.py` writes
`worldmask.c`.

Relaunch from stored data on the SDK 4.44 emulator, from the launch command to
a full frame (`scripts/emulator-launch-timing.py`, median of 5–6 launches):

| | Time 2: clock | Time 2: globe | Round 2: clock | Round 2: globe |
|---|---|---|---|---|
| 1.2.0 JavaScript | 0.27 s | 0.44 s | 0.44 s | 0.80 s |
| native C | 0.09 s | 0.09 s | 0.09 s | 0.09 s |

QEMU does not run at watch speed, and each screendump takes about 40 ms, so
read the ratio, not the seconds. The C app's whole RAM footprint (code,
tables and state) is 36.7 KB of the 128 KB app space; the JavaScript face
reserved 57 KB of XS pools before loading anything.

`package.json` sets `"manifestVersion": 1`. Without `usesPermissions`, SDK 4.44
warns that the phone-side JavaScript can't make network requests, and 1 keeps
the phone behaviour of 1.2.0 (Open-Meteo, GeoJS, location). Declaring the
permissions instead is the newer route.

## Stability checks

```sh
node --test tests/*.cjs       # host-side regressions (needs gcc)
pebble build                 # compile for emery and gabbro
pebble install --emulator emery
pebble screenshot --no-open --emulator emery screenshot_emery.png
```

`tests/c-port.cjs` compiles `src/c` with `gcc` against a stand-in `pebble.h`
(`tests/c/`). It runs the same scripts through it and the 1.2.0 JavaScript face
(`tests/reference/`): a day of ticks, every theme and weather icon, 12-hour time,
offline and location-only starts, polar days, quick views, relaunch from storage,
payload edge cases, and 60 random places and dates. Every pixel outside the globe
and every text draw must match exactly. Inside the disc, at most 1% of pixels may
differ; in practice it is 0.15% or less, where fixed-point rounding moves a
coastline or terminator sample.

Host-side tests mock the hardware boundaries; they do not replace an emulator
run or paired-phone testing. Before treating a
build as a daily-driver release, test location permission denial, Bluetooth
reconnection, a day rollover, and battery use on a real watch. The solar shading
is an approximation, not a navigation or astronomical instrument.

## Project layout

```
src/c/yearlight.c              The watchface: state, HUD, phone messages, storage
src/c/globe.c                  Globe sampling, land projection and shading
src/c/worldmask.c              Land mask table (scripts/gen_globe.py)
src/c/yearstars.c              Year star tables (round ones by scripts/gen-round-stars.cjs)
src/pkjs/index.js              PebbleKit JS (phone-side) code
scripts/emulator-launch-timing.py  Launch-to-paint times on the emulator
tests/reference/               The 1.2.0 JavaScript face, the port's reference
package.json                   Project metadata (UUID, platforms, resources)
wscript                        Build rules — usually no need to edit
```

## Documentation

Full SDK docs and tutorials: <https://developer.repebble.com>

## Credits

Inspired by Ren Gianforte's [Day and Night Earth](https://apps.repebble.com/day-and-night-earth-watchface_530bd23d3add7beccc0001e3) watchface ([source](https://github.com/rengianforte/pebble-day-night)). This is a separate implementation, not a fork.

[Weather data by Open-Meteo.com](https://open-meteo.com/) (CC BY 4.0). Globe geography is made with [Natural Earth](https://www.naturalearthdata.com/). Solar position follows [NOAA GML](https://gml.noaa.gov/grad/solcalc/) calculations.

Full notices are in [CREDITS.md](CREDITS.md).
