# Day Night stabilization checkpoint

## Verified

- `node --test tests/*.cjs`: 47 passing (43 weather/lifecycle/code-mapping, 4 solar).
- `pebble build`: succeeds on SDK 4.33.1 / Emery. Linker emits an RWX LOAD-segment warning; not a warning-free build.
- Installed and visually inspected in the Emery emulator: map, time/date, actual fetched temperature/condition, sunrise and sunset render.
- Survived startup, forecast completion and subsequent minute updates with instrumentation active.
- `git diff --check`: clean.

## Changes

- UTC solar-position calculation fixes equinox noon/night inversion.
- Startup location lookup and hourly weather refresh restored.
- Location/network timeouts, bounded retry and late-result invalidation.
- HTTPS forecast request includes hourly precipitation and daily sun events with Unix timestamps.
- Defensive response validation and visible stale weather status.
- Explicit XS pools: stack 6144, slots 24576, chunks 16384 bytes. Defaults caused fatal memory exhaustion. Firmware requires all three overrides together.

## Remaining release gates

This is an emulator-verified development checkpoint, not a device-soaked release.
Test a real paired phone/watch for denied location permission, Bluetooth loss/reconnection, overnight day rollover, rain-strip appearance, travel/timezone changes and battery life.
Location is acquired at launch; hourly refresh reuses those coordinates until relaunch. Cached weather is session-only. Fetch timeouts invalidate results but do not physically abort requests.
The emulator's location is not evidence of the user's real location.

Original working-tree changes were preserved; no commit or publication was made. An emulator SPI state backup was retained when recovering a boot-looping experimental allocation.
