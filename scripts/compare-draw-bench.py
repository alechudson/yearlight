#!/usr/bin/env python3
import json
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PERF = ROOT / "artifacts" / "perf"
DB = PERF / "compare.sqlite"
OUT = PERF / "compare.json"

rows = []
for path in sorted(PERF.glob("*.json")):
    if path.name == "compare.json":
        continue
    data = json.loads(path.read_text())
    steady = data["steady"]
    rows.append({
        "label": data["label"],
        "ms_per_tick": steady["msPerTick"],
        "asin_per_tick": steady.get("asinPerTick", 0),
        "atan2_per_tick": steady.get("atan2PerTick", 0),
        "sqrt_per_tick": steady.get("sqrtPerTick", 0),
        "globe_rects_per_tick": steady["globeRectsPerTick"],
        "full_begins_per_tick": steady.get("fullBeginsPerTick", 1),
        "hud_begins_per_tick": steady.get("hudBeginsPerTick", 0),
    })

conn = sqlite3.connect(DB)
conn.execute("DROP TABLE IF EXISTS draw_ticks")
conn.execute(
    """CREATE TABLE draw_ticks (
        label TEXT PRIMARY KEY,
        ms_per_tick REAL,
        asin_per_tick REAL,
        atan2_per_tick REAL,
        sqrt_per_tick REAL,
        globe_rects_per_tick REAL,
        full_begins_per_tick REAL,
        hud_begins_per_tick REAL
    )"""
)
conn.executemany(
    "INSERT INTO draw_ticks VALUES (?,?,?,?,?,?,?,?)",
    [(r["label"], r["ms_per_tick"], r["asin_per_tick"], r["atan2_per_tick"], r["sqrt_per_tick"],
      r["globe_rects_per_tick"], r["full_begins_per_tick"], r["hud_begins_per_tick"]) for r in rows],
)
conn.commit()
by_label = {r["label"]: r for r in rows}
head = by_label["HEAD"]
post = by_label["post-fix"]
compare = {
    "unit": "host ms per minutechange tick, 59-tick steady window",
    "HEAD": head,
    "post-fix": post,
    "delta": {
        "ms_per_tick": post["ms_per_tick"] / head["ms_per_tick"],
        "sqrt_per_tick": post["sqrt_per_tick"] / head["sqrt_per_tick"] if head["sqrt_per_tick"] else None,
        "globe_rects_per_tick": post["globe_rects_per_tick"] / head["globe_rects_per_tick"],
    },
}
OUT.write_text(json.dumps(compare, indent=2) + "\n")
print(json.dumps(compare, indent=2))
print(f"wrote {OUT}")
print(f"wrote {DB}")
