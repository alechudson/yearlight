#pragma once
#include <pebble.h>

// The subsolar point: the map angles of the sun (x from longitude -180, y
// southward) with their sines and cosines, and its longitude/latitude.
typedef struct {
  double sin_x, cos_x, sin_y, cos_y;
  double lon, lat;
} Sun;

// sin(-0.833°): NOAA apparent sunrise (refraction plus the solar radius).
#define NIGHT_SIN (-0.014538080502496949)

// Sets up the 2x2-sample grid of a globe centered at (map_w / 2, globe_cy).
void globe_init(int map_w, int map_h, int globe_cy, int globe_r);

// Works out which samples are land, ocean, day and night for a view origin
// (degrees) and sun. The land only changes with the origin.
void globe_shade(double lon, double lat, const Sun *sun);

// Paints the shaded globe, one rectangle per run of a color along each row.
void globe_draw(GContext *ctx);
