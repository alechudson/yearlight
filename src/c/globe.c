#include "globe.h"

#include <math.h>
#include <string.h>

#include "tables.h"

// Watch apps are built for a Cortex-M3 with no FPU, so every float operation
// is a library call. Every pixel of the disc is a sample, read at its center:
// sample offsets from the globe's center are kept in half pixels (odd
// numbers). Per-sample work here is integer: positions in 1/256 px,
// directions in Q14/Q15 and angles in binary turns (2^32 = 360°). Doubles are
// only used a handful of times per shade, for the view and sun directions.

#define PI 3.14159265358979323846
#define MAX_SIDE 144  // samples per row or column (globe radius up to 72 px)
#define NO_SPAN 255

static int s_cx, s_cy, s_r, s_x0, s_y0, s_sample_w, s_rows;
// Row r of samples is pixel row s_y0 + r; sample i is pixel column s_x0 + i.
// The disc covers samples s_span_a[r]..s_span_b[r].
static uint8_t s_span_a[MAX_SIDE];
static uint8_t s_span_b[MAX_SIDE];
// Sine of each mask row's top edge latitude, in the same units as Py.
static int32_t s_lat_edge[MASK_H + 1];
// atan coefficients in binary turns.
static int64_t s_atan_k[5];

static uint8_t s_land[(MAX_SIDE * MAX_SIDE + 7) / 8];
static uint8_t s_color[(MAX_SIDE * MAX_SIDE + 3) / 4];
static bool s_land_valid;
static bool s_land_unsaved;
static double s_land_lon, s_land_lat;

static const uint8_t GLOBE_COLORS[4] = {
  0xC3,  // day ocean (0, 0, 255)
  0xC1,  // night ocean (0, 0, 85)
  0xCC,  // day land (0, 255, 0)
  0xC4,  // night land (0, 85, 0)
};

static uint32_t isqrt32(uint32_t n) {
  uint32_t root = 0;
  uint32_t bit = 1u << 30;
  while (bit > n)
    bit >>= 2;
  while (bit) {
    if (n >= root + bit) {
      n -= root + bit;
      root = (root >> 1) + bit;
    } else
      root >>= 1;
    bit >>= 2;
  }
  return root;
}

// atan2(y, x) in binary turns, for |x|, |y| < 2^15. A minimax polynomial on
// the first octant (Abramowitz & Stegun 4.4.49, error 1e-5 rad).
static uint32_t atan2_turn(int32_t y, int32_t x) {
  if (x == 0 && y == 0)
    return 0;
  const uint32_t ax = x < 0 ? -x : x;
  const uint32_t ay = y < 0 ? -y : y;
  const bool steep = ay > ax;
  const int64_t z = ((steep ? ax : ay) << 16) / (steep ? ay : ax);  // tan in Q16, 0..1
  const int64_t z2 = (z * z) >> 16;
  int64_t p = s_atan_k[4];
  for (int k = 3; k >= 0; k--)
    p = s_atan_k[k] + ((p * z2) >> 16);
  uint32_t a = (uint32_t)((p * z) >> 16);  // 0..1/8 turn
  if (steep)
    a = (1u << 30) - a;
  if (x < 0)
    a = (1u << 31) - a;
  if (y < 0)
    a = 0u - a;
  return a;
}

static uint32_t turn_from_deg(double deg) {
  return (uint32_t)(int64_t)llround(deg / 360.0 * 4294967296.0);
}

// Pixel centers as offsets from the globe's center, in half pixels: x grows
// right, y grows up.
static int half_x(int i) {
  return 2 * (s_x0 + i - s_cx) + 1;
}

static int half_y(int r) {
  return 2 * (s_cy - s_y0 - r) - 1;
}

void globe_init(int map_w, int map_h, int globe_cy, int globe_r) {
  s_cx = map_w / 2;
  s_cy = globe_cy;
  s_r = globe_r < MAX_SIDE ? globe_r : MAX_SIDE;
  const int x0 = s_cx - s_r;
  const int x1 = s_cx + s_r;  // exclusive
  const int y0 = s_cy - s_r;
  const int y1 = s_cy + s_r;
  s_x0 = x0 > 0 ? x0 : 0;
  s_y0 = y0 > 0 ? y0 : 0;
  s_sample_w = (x1 < map_w ? x1 : map_w) - s_x0;
  s_rows = (y1 < map_h ? y1 : map_h) - s_y0;
  const int r2 = 4 * s_r * s_r;
  for (int r = 0; r < s_rows; r++) {
    const int y = half_y(r);
    int a = -1;
    int b = -1;
    for (int i = 0; i < s_sample_w; i++) {
      const int x = half_x(i);
      if (x * x + y * y <= r2) {
        if (a < 0)
          a = i;
        b = i;
      }
    }
    s_span_a[r] = a < 0 ? NO_SPAN : a;
    s_span_b[r] = b < 0 ? 0 : b;
  }
  for (int k = 0; k <= MASK_H; k++)
    s_lat_edge[k] = (int32_t)lround(sin((90.0 - 180.0 * k / MASK_H) * PI / 180) * s_r * 256);
  static const double A[5] = {0.9998660, -0.3302995, 0.1801410, -0.0851330, 0.0208351};
  for (int k = 0; k < 5; k++)
    s_atan_k[k] = llround(A[k] * 4294967296.0 / (2 * PI));
  s_land_valid = false;
}

// Mask row of a point at height py (1/256 px) on the sphere: the last row
// whose top edge is at or above it.
static int lat_row(int32_t py) {
  int lo = 0;
  int hi = MASK_H;
  while (lo < hi) {
    const int mid = (lo + hi + 1) >> 1;
    if (s_lat_edge[mid] >= py)
      lo = mid;
    else
      hi = mid - 1;
  }
  return lo < MASK_H ? lo : MASK_H - 1;
}

// z (1/256 px) of the sample at half-pixel offsets (x, y): sqrt(4r² - x² - y²) / 2.
static int32_t sample_z(int x, int y) {
  return (int32_t)isqrt32((uint32_t)(4 * s_r * s_r - x * x - y * y) << 14);
}

// The inverse orthographic projection of every sample, against the land mask.
static void compute_land(double lon, double lat) {
  const int32_t c0 = (int32_t)lround(cos(lat * PI / 180) * 32768);
  const int32_t s0 = (int32_t)lround(sin(lat * PI / 180) * 32768);
  // + 180°: mask column 0 is longitude -180.
  const uint32_t lon0 = turn_from_deg(lon) + 0x80000000u;
  memset(s_land, 0, sizeof(s_land));
  for (int r = 0; r < s_rows; r++) {
    if (s_span_a[r] == NO_SPAN)
      continue;
    const int y = half_y(r);
    const int32_t yq = y * 128;
    for (int i = s_span_a[r]; i <= s_span_b[r]; i++) {
      const int x = half_x(i);
      const int32_t zq = sample_z(x, y);
      const int32_t py = (yq * c0 + zq * s0) >> 15;
      const int32_t pz = (zq * c0 - yq * s0) >> 15;
      const uint32_t a = lon0 + atan2_turn(x * 128, pz);
      const int mx = (int)(((uint64_t)a * MASK_W) >> 32);
      const int bit = lat_row(py) * MASK_W + mx;
      if ((WORLD_MASK[bit >> 3] >> (bit & 7)) & 1) {
        const int k = r * s_sample_w + i;
        s_land[k >> 3] |= 1 << (k & 7);
      }
    }
  }
}

// ---------------------------------------------------------------- land cache

// The land of the last place is kept in storage, so a relaunch there reads
// it back instead of projecting every pixel again. Only the disc's bits are
// kept. The header names everything the bits depend on: the place, to the
// last bit of each double, the globe's geometry, the land mask and this
// code's version; anything that differs, or a checksum that fails, and the
// land is computed afresh. A restored globe is the computed one, bit for bit.
//
// Bump LAND_VERSION whenever compute_land or the sample grid changes.
#define LAND_VERSION 1
#define LAND_KEY_HEAD 10
#define LAND_KEY_DATA 11  // and on, one key per LAND_CHUNK bytes
#define LAND_CHUNK 240

typedef struct {
  uint16_t version;
  uint16_t bytes;
  int16_t cx, cy, r, x0, y0, sample_w, rows;
  uint32_t mask_hash;
  uint32_t checksum;
  double lon, lat;
} LandHead;

static uint32_t fnv1a(uint32_t h, const uint8_t *data, size_t n) {
  for (size_t i = 0; i < n; i++)
    h = (h ^ data[i]) * 16777619u;
  return h;
}

static uint32_t mask_hash(void) {
  static uint32_t hash;
  if (!hash)
    hash = fnv1a(2166136261u, WORLD_MASK, sizeof(WORLD_MASK)) | 1;
  return hash;
}

static void land_head(LandHead *head, double lon, double lat, int bytes, uint32_t checksum) {
  memset(head, 0, sizeof(*head));
  head->version = LAND_VERSION;
  head->bytes = bytes;
  head->cx = s_cx;
  head->cy = s_cy;
  head->r = s_r;
  head->x0 = s_x0;
  head->y0 = s_y0;
  head->sample_w = s_sample_w;
  head->rows = s_rows;
  head->mask_hash = mask_hash();
  head->checksum = checksum;
  head->lon = lon;
  head->lat = lat;
}

// Samples inside the disc: the land bits kept, in span order.
static int disc_samples(void) {
  int n = 0;
  for (int r = 0; r < s_rows; r++)
    if (s_span_a[r] != NO_SPAN)
      n += s_span_b[r] - s_span_a[r] + 1;
  return n;
}

static int chunk_len(int bytes, int key) {
  const int at = (key - LAND_KEY_DATA) * LAND_CHUNK;
  return bytes - at < LAND_CHUNK ? bytes - at : LAND_CHUNK;
}

// Reads the bits back one storage key at a time, straight into s_land.
static bool load_land(double lon, double lat) {
  LandHead stored;
  if (persist_read_data(LAND_KEY_HEAD, &stored, sizeof(stored)) != (int)sizeof(stored))
    return false;
  const int bits = disc_samples();
  const int bytes = (bits + 7) / 8;
  LandHead want;
  land_head(&want, lon, lat, bytes, stored.checksum);
  if (memcmp(&want, &stored, sizeof(want)) != 0)
    return false;
  uint8_t chunk[LAND_CHUNK];
  uint32_t hash = 2166136261u;
  int key = LAND_KEY_DATA;
  int n = 0;  // bit within the chunk
  memset(s_land, 0, sizeof(s_land));
  for (int r = 0; r < s_rows; r++) {
    if (s_span_a[r] == NO_SPAN)
      continue;
    for (int i = s_span_a[r]; i <= s_span_b[r]; i++, n++) {
      if (n == LAND_CHUNK * 8)
        n = 0;
      if (n == 0) {
        const int len = chunk_len(bytes, key);
        if (persist_read_data(key++, chunk, len) != len)
          return false;
        hash = fnv1a(hash, chunk, len);
      }
      if ((chunk[n >> 3] >> (n & 7)) & 1) {
        const int k = r * s_sample_w + i;
        s_land[k >> 3] |= 1 << (k & 7);
      }
    }
  }
  return hash == stored.checksum;
}

bool globe_land_unsaved(void) {
  return s_land_valid && s_land_unsaved;
}

void globe_save_land(void) {
  if (!globe_land_unsaved())
    return;
  const int bytes = (disc_samples() + 7) / 8;
  uint8_t chunk[LAND_CHUNK];
  uint32_t hash = 2166136261u;
  int key = LAND_KEY_DATA;
  int n = 0;
  memset(chunk, 0, sizeof(chunk));
  for (int r = 0; r < s_rows; r++) {
    if (s_span_a[r] == NO_SPAN)
      continue;
    for (int i = s_span_a[r]; i <= s_span_b[r]; i++) {
      const int k = r * s_sample_w + i;
      if ((s_land[k >> 3] >> (k & 7)) & 1)
        chunk[n >> 3] |= 1 << (n & 7);
      if (++n == LAND_CHUNK * 8) {
        hash = fnv1a(hash, chunk, LAND_CHUNK);
        persist_write_data(key++, chunk, LAND_CHUNK);
        memset(chunk, 0, sizeof(chunk));
        n = 0;
      }
    }
  }
  if (n) {
    const int len = chunk_len(bytes, key);
    hash = fnv1a(hash, chunk, len);
    persist_write_data(key, chunk, len);
  }
  // The header goes last: a write cut short leaves a header whose checksum
  // fails against the new bits, so the land is computed again.
  LandHead head;
  land_head(&head, s_land_lon, s_land_lat, bytes, hash);
  persist_write_data(LAND_KEY_HEAD, &head, sizeof(head));
  s_land_unsaved = false;
}

// ---------------------------------------------------------------- shading

void globe_shade(double lon, double lat, const Sun *sun) {
  if (!s_land_valid || lon != s_land_lon || lat != s_land_lat) {
    const bool restored = load_land(lon, lat);
    if (!restored)
      compute_land(lon, lat);
    s_land_unsaved = !restored;
    s_land_valid = true;
    s_land_lon = lon;
    s_land_lat = lat;
  }
  // The sun's direction rotated into the view frame: night is where it points
  // away from a sample's surface normal by more than NIGHT_SIN.
  const double lon0 = lon * PI / 180;
  const double lat0 = lat * PI / 180;
  const double sin_lat0 = sin(lat0);
  const double cos_lat0 = cos(lat0);
  const double sin_lon0 = sin(lon0);
  const double cos_lon0 = cos(lon0);
  const double sun_x = -sun->cos_y * sun->cos_x;
  const double sun_y = -sun->cos_y * sun->sin_x;
  const double sun_z = -sun->sin_y;
  const double toward = sun_x * cos_lon0 + sun_y * sin_lon0;
  const int32_t vx = (int32_t)lround((sun_y * cos_lon0 - sun_x * sin_lon0) * 16384);
  const int32_t vy = (int32_t)lround((sun_z * cos_lat0 - toward * sin_lat0) * 16384);
  const int32_t vz = (int32_t)lround((toward * cos_lat0 + sun_z * sin_lat0) * 16384);
  const int32_t limit = (int32_t)lround(NIGHT_SIN * s_r * 256 * 16384);
  memset(s_color, 0, sizeof(s_color));
  for (int r = 0; r < s_rows; r++) {
    if (s_span_a[r] == NO_SPAN)
      continue;
    const int y = half_y(r);
    const int32_t vyy = vy * y * 128;
    for (int i = s_span_a[r]; i <= s_span_b[r]; i++) {
      const int x = half_x(i);
      const int k = r * s_sample_w + i;
      const int night = vx * x * 128 + vyy + vz * sample_z(x, y) < limit;
      const int land = (s_land[k >> 3] >> (k & 7)) & 1;
      s_color[k >> 2] |= (land * 2 + night) << ((k & 3) * 2);
    }
  }
}

void globe_draw(GContext *ctx) {
  for (int r = 0; r < s_rows; r++) {
    if (s_span_a[r] == NO_SPAN)
      continue;
    const int y = s_y0 + r;
    const int base = r * s_sample_w;
    int start = s_span_a[r];
    int color = (s_color[(base + start) >> 2] >> (((base + start) & 3) * 2)) & 3;
    for (int i = start + 1; i <= s_span_b[r] + 1; i++) {
      const int k = base + i;
      const int c = i <= s_span_b[r] ? (s_color[k >> 2] >> ((k & 3) * 2)) & 3 : -1;
      if (c == color)
        continue;
      GColor fill;
      fill.argb = GLOBE_COLORS[color];
      graphics_context_set_fill_color(ctx, fill);
      graphics_fill_rect(ctx, GRect(s_x0 + start, y, i - start, 1), 0, GCornerNone);
      start = i;
      color = c;
    }
  }
}
