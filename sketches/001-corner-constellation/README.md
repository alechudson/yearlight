## Variant: Corner constellation

### Design stance
Treat the leftover black around the globe as sky, and put a 52-week constellation in that sky — not a halo that needs the planet to shrink.

### Key choices
- Layout: globe stays 64px; stars only in the 200×132 map void (side gutters + four corners)
- Typography: unchanged HUD
- Color: completed white, current yellow, future navy `#000055`, season markers cyan
- Interaction: day-of-year slider; stars ignite in angular order around the planet

### Trade-offs
- Strong at: using real leftover pixels, keeping Earth dominant, remaining watch-like
- Weak at: 12 o’clock and 6 o’clock stay empty because the globe already touches those edges

### Best for
Daily-driver watchface where year progress should be peripheral and the time still wins.
