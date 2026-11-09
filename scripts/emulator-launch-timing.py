#!/usr/bin/env python3
"""Time how long the face takes to paint after a launch, on a Pebble emulator.

Run it with pebble-tool's Python, which has libpebble2 (and Pillow), against an
emulator that `pebble install --emulator <platform>` started:

    ~/.local/share/uv/tools/pebble-tool/bin/python scripts/emulator-launch-timing.py emery 6

It stops and starts the app over the Pebble protocol, then screendumps the
display through the QEMU monitor until the clock and then the globe are on
screen, and prints the seconds each took. The emulator's serial port takes
one client: if pypkjs holds it ("the watch didn't answer"), stop pypkjs first.
Send the face a forecast before timing so it launches from stored data.

QEMU does not run at watch speed, and each screendump takes ~40 ms: compare
builds with it, not absolute times.
"""
import json
import os
import socket
import statistics
import sys
import tempfile
import time
import uuid

from PIL import Image
from libpebble2.communication import PebbleConnection
from libpebble2.communication.transports.qemu import QemuTransport
from libpebble2.protocol.apps import AppRunState, AppRunStateStart, AppRunStateStop

APP = uuid.UUID("cf9c0d01-1aa2-44b2-a79f-644baa16d24c")
# Globe disc and a row through the clock digits, per platform.
GEOMETRY = {"emery": (100, 66, 64, 150), "gabbro": (130, 78, 70, 170)}


def main():
    platform = sys.argv[1] if len(sys.argv) > 1 else "emery"
    trials = int(sys.argv[2]) if len(sys.argv) > 2 else 6
    info = json.load(open(os.path.join(tempfile.gettempdir(), "pb-emulator.json")))[platform]
    qemu = next(iter(info.values()))["qemu"]
    cx, cy, r, clock_y = GEOMETRY[platform]

    pebble = PebbleConnection(QemuTransport("localhost", qemu["port"]))
    pebble.connect()
    pebble.run_async()
    monitor = socket.create_connection(("127.0.0.1", qemu["monitor"]), timeout=5)

    def prompt():
        buf = b""
        while not buf.endswith(b"(qemu) "):
            buf += monitor.recv(65536)

    prompt()
    dump = os.path.join(tempfile.gettempdir(), f"yearlight-{platform}.ppm")

    def screen():
        monitor.sendall(f"screendump {dump}\n".encode())
        prompt()
        return Image.open(dump).convert("RGB")

    def painted(im):
        row = [sum(im.getpixel((x, clock_y))) for x in range(40, im.size[0] - 40)]
        clock = min(row) < 50 and max(row) >= 250
        globe = 0
        for dy in range(-r + 8, r - 8, 6):
            for dx in range(-r + 8, r - 8, 6):
                if dx * dx + dy * dy < (r - 8) ** 2:
                    red, green, blue = im.getpixel((cx + dx, cy + dy))
                    globe += blue > red + 20 or green > red + 20
        return clock, globe > 40

    clocks, globes = [], []
    for trial in range(trials):
        pebble.send_packet(AppRunState(data=AppRunStateStop(uuid=APP)))
        time.sleep(2)
        start = time.monotonic()
        pebble.send_packet(AppRunState(data=AppRunStateStart(uuid=APP)))
        clock_at = globe_at = None
        while time.monotonic() - start < 20 and globe_at is None:
            clock, globe = painted(screen())
            now = time.monotonic() - start
            if clock and clock_at is None:
                clock_at = now
            if clock and globe:
                globe_at = now
        print(f"launch {trial}: clock {clock_at}, globe {globe_at}")
        if globe_at is not None:
            clocks.append(clock_at)
            globes.append(globe_at)
    if globes:
        print(f"median: clock {statistics.median(clocks):.2f} s, globe {statistics.median(globes):.2f} s")


if __name__ == "__main__":
    main()
