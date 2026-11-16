# Rain on the ruler

A design study for the Time 2. Production source is unchanged.

The icon and the temperature stay “now.” Rain later is drawn on the solar ruler, which is already the rest of this daylight, or the rest of this night.

- A dry hour stays the one-pixel line.
- A wet hour is three pixels of the same ink, centered on that line.
- The now-dot is drawn after the bar. Its paper halo keeps the dot readable when you are standing in the rain.
- The icon changes only when it is raining now.
- End ticks and the rise/set labels stay where they are.

Hourly precipitation would be reduced to a few spans on the phone. A gap shorter than about 45 minutes joins the spans beside it, so a showery hour does not become a barcode.

`board.png` is the sheet. The numbered files are the native 200×228 frames. The theme files are the same raining-now moment on Classic, All black, and Gray.

The sample is Saturday Oct 31, sunrise 7:44a, sunset 6:44p. The globe is held still, from an emulator frame, so the ruler is the only change. Type is Montserrat Bold snapped to pixels, standing in for Bitham and Gothic. The ruler geometry matches emery in `src/embeddedjs/main.js`.
