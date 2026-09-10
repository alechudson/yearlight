# Credits

This watchface is original code by Alec Hudson except as noted below.
It is not a fork of any other Pebble project.

## Inspiration

The sunlight-on-earth idea follows Ren Gianforte's **Day and Night Earth**
watchface (MIT). Layout, projection, weather, almanac, and drawing code here
are a separate implementation.

- https://apps.repebble.com/day-and-night-earth-watchface_530bd23d3add7beccc0001e3
- https://github.com/rengianforte/pebble-day-night

## Map

Globe land/lake pixels in `src/embeddedjs/worldmask.js` are rasterized from
Natural Earth 1:110m vectors. Natural Earth is in the public domain; credit is
optional. Made with Natural Earth.

- https://www.naturalearthdata.com/about/terms-of-use/
- https://github.com/nvkelso/natural-earth-vector

## Weather and location

Forecast temperature, WMO weather codes, sunrise, and sunset come from
[Open-Meteo](https://open-meteo.com/) (CC BY 4.0). Open-Meteo asks for a link
next to displayed data; a Pebble face cannot show a URL, so that credit lives
here and in the README.

- https://open-meteo.com/
- https://open-meteo.com/en/licence
- https://creativecommons.org/licenses/by/4.0/

If phone GPS is unavailable, the phone falls back to [ip-api](https://ip-api.com/)
for approximate coordinates. The free API is for non-commercial use.

Weather-condition numbers are [WMO interpretation codes](https://open-meteo.com/en/docs)
as served by Open-Meteo. The 16px icons drawn on the watch are original.

## Solar and lunar math

Subsolar position, equation of time, declination, and the −0.833° apparent
sunrise threshold follow NOAA Global Monitoring Laboratory solar calculations
(U.S. government work, public domain):

- https://gml.noaa.gov/grad/solcalc/
- https://gml.noaa.gov/grad/solcalc/solareqns.PDF

Moon-phase index uses the mean synodic month and new-moon epoch JDE 2451550.1
from Jean Meeus, *Astronomical Algorithms*, 2nd ed. (Willmann-Bell, 1998).
Phase bitmaps are original.

## Platform

Built with the [Rebble / Pebble SDK](https://developer.repebble.com), the
[Moddable](https://www.moddable.com/) XS runtime and Commodetto/Poco renderer,
and the `@moddable/pebbleproxy` build helper (LGPL-3.0-or-later). Those are
not vendored in this repository.

On-watch type uses Pebble system fonts **Bitham-Bold** and **Gothic-Bold**;
the font files are not included here.
