// Yearlight: sunlight moving across a location-centered globe, a large clock,
// the date, local weather, and a day/night progress ruler.
//
// A native port of the Moddable JavaScript face (kept as tests/reference/main.js,
// which tests/c-port.cjs holds this build to). Function names follow it.

#include <pebble.h>

#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "globe.h"
#include "tables.h"

#define PI 3.14159265358979323846

// ---------------------------------------------------------------- layout

typedef struct {
  int16_t map_w, map_h, globe_cy, globe_r;
  int16_t caption_y, caption_inset;
  int16_t ruler_y, solar_label_y, ruler_inset, solar_label_inset;
} Layout;

// Round 2 (gabbro, 260x260) stacks the same sky-over-HUD layout inside the
// circle: a larger globe, and HUD rows pulled in from the curved edge.
static const Layout LAYOUT_ROUND = {260, 150, 78, 70, 192, 30, 216, 221, 40, 56};
// The bottom row stays clear of the rounded screen corners the appstore's
// Time 2 frame draws over screenshots.
static const Layout LAYOUT_RECT = {200, 132, 66, 64, 174, 9, 200, 205, 16, 16};

static const Layout *L = &LAYOUT_RECT;
static bool s_round;

#define GLOBE_TILT_MAX 40
#define TERMINATOR_MS (30 * 60 * 1000)
#define STALE_MS 7200000
// Bold Gothic digits touch at the HUD sizes, so "24" reads as one glyph;
// adjacent digits get a pixel of air.
#define DIGIT_GAP 1

// ---------------------------------------------------------------- colors

enum {
  BLACK = 0xC0,
  WHITE = 0xFF,
  YELLOW = 0xFC,
  CYAN = 0xCF,
  DARK_GRAY = 0xD5,
  LIGHT_GRAY = 0xEA,
  DEEP_BLUE = 0xC2,
};

static GColor color8(uint8_t argb) {
  GColor c;
  c.argb = argb;
  return c;
}

// sky_muted is a quiet ink for the sky: the battery reads below the stars.
typedef struct {
  uint8_t sky, paper, ink, muted, star, season, sky_muted;
} Theme;

static const Theme THEMES[] = {
  {BLACK, WHITE, BLACK, DARK_GRAY, WHITE, CYAN, LIGHT_GRAY},
  {BLACK, BLACK, WHITE, LIGHT_GRAY, WHITE, CYAN, LIGHT_GRAY},
  {WHITE, WHITE, BLACK, DARK_GRAY, BLACK, DEEP_BLUE, DARK_GRAY},
  {DARK_GRAY, DARK_GRAY, WHITE, WHITE, WHITE, CYAN, LIGHT_GRAY},
  {BLACK, DARK_GRAY, WHITE, WHITE, WHITE, CYAN, LIGHT_GRAY},
};
#define THEME_COUNT ((int)(sizeof(THEMES) / sizeof(THEMES[0])))
static int s_theme;

// ---------------------------------------------------------------- fonts

// Text sits as the Moddable face drew it: a box whose top is the cap offset
// (max_height * 22 / 100 in the firmware) above the requested y, plus one.
typedef struct {
  GFont font;
  int16_t cap;
} Font;

static Font s_time_font, s_date_font, s_small_font;

static int text_width(const char *text, const Font *font) {
  return graphics_text_layout_get_content_size(text, font->font, GRect(0, 0, 10000, 100),
                                               GTextOverflowModeTrailingEllipsis,
                                               GTextAlignmentLeft).w;
}

static void draw_text(GContext *ctx, const char *text, const Font *font, uint8_t color, int x,
                      int y) {
  graphics_context_set_text_color(ctx, color8(color));
  graphics_draw_text(ctx, text, font->font, GRect(x, y - font->cap + 1, 10000, 127),
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
}

static bool is_digit(char c) {
  return c >= '0' && c <= '9';
}

static int tracked_width(const char *text, const Font *font) {
  int width = text_width(text, font);
  for (int i = 1; text[i]; i++)
    if (is_digit(text[i - 1]) && is_digit(text[i]))
      width += DIGIT_GAP;
  return width;
}

static void draw_tracked(GContext *ctx, const char *text, const Font *font, uint8_t color, int x,
                         int y) {
  char part[32];
  const int n = strlen(text);
  int start = 0;
  for (int i = 1; i <= n; i++) {
    if (i < n && !(is_digit(text[i - 1]) && is_digit(text[i])))
      continue;
    int len = i - start;
    if (len > (int)sizeof(part) - 1)
      len = sizeof(part) - 1;
    memcpy(part, text + start, len);
    part[len] = 0;
    draw_text(ctx, part, font, color, x, y);
    x += text_width(part, font) + DIGIT_GAP;
    start = i;
  }
}

static void fill(GContext *ctx, uint8_t color, int x, int y, int w, int h) {
  graphics_context_set_fill_color(ctx, color8(color));
  graphics_fill_rect(ctx, GRect(x, y, w, h), 0, GCornerNone);
}

// ---------------------------------------------------------------- state

enum { LOADING, READY, STALE, OFFLINE };

typedef struct {
  int32_t day;
  int64_t sunrise, sunset;  // ms; 0 for none
} SolarDay;

static struct {
  int status;
  bool has_location;
  double lat, lon;
  bool has_weather;
  int temp;
  int code;
  int32_t utc_offset;
  SolarDay days[4];
  int day_count;
  double updated_at;
} s;

static bool s_default_globe;

static Window *s_window;
static Layer *s_canvas;

static int64_t now_ms(void) {
  return (int64_t)time(NULL) * 1000;
}

static int64_t floor_div(int64_t a, int64_t b) {
  int64_t q = a / b;
  if ((a % b != 0) && ((a < 0) != (b < 0)))
    q--;
  return q;
}

// Math.round.
static double js_round(double v) {
  double r = floor(v);
  return v - r >= 0.5 ? r + 1 : r;
}

static void mark_dirty(void) {
  if (s_canvas)
    layer_mark_dirty(s_canvas);
}

// ---------------------------------------------------------------- sun

// Low-precision solar coordinates (Astronomical Almanac): about 0.01° in
// declination and a few seconds of equation of time, with no drift across years.
static Sun sun_at(int64_t ms) {
  const double n = (double)ms / 86400000 - 10957.5;
  const double rad = PI / 180;
  const double mean = fmod(280.460 + 0.9856474 * n, 360);
  const double g = (357.528 + 0.9856003 * n) * rad;
  const double lambda = (mean + 1.915 * sin(g) + 0.020 * sin(2 * g)) * rad;
  const double tilt = (23.439 - 0.0000004 * n) * rad;
  const double ra = atan2(cos(tilt) * sin(lambda), cos(lambda)) / rad;
  const double equation = 4 * (fmod(fmod(mean - ra, 360) + 540, 360) - 180);
  const double declination = asin(sin(tilt) * sin(lambda));
  const int64_t day_s = floor_div(ms, 1000) - floor_div(ms, 86400000) * 86400;
  const int hours = day_s / 3600;
  const int minutes_of_hour = (day_s / 60) % 60;
  const int seconds = day_s % 60;
  const double minutes = (double)(hours * 60 + minutes_of_hour) + seconds / 60.0;
  // Map x=0 is longitude -180; map y grows southward.
  const double x = 2 * PI - (minutes + equation) * PI / 720;
  const double y = -declination;
  Sun sun = {sin(x), cos(x), sin(y), cos(y), x * 180 / PI - 180, declination * 180 / PI};
  return sun;
}

static bool is_night_lon_lat(double lon, double lat, const Sun *sun) {
  const double xa = (lon + 180) * PI / 180;
  const double lat_r = lat * PI / 180;
  return sun->sin_y * sin(-lat_r) +
             sun->cos_y * cos(lat_r) * (sun->cos_x * cos(xa) + sun->sin_x * sin(xa)) <
         NIGHT_SIN;
}

static bool project_globe(double lon, double lat, double lon0, double sin_lat0, double cos_lat0,
                          GPoint *out) {
  const double lat_r = lat * PI / 180;
  const double dlon = lon * PI / 180 - lon0;
  const double sin_lat = sin(lat_r);
  const double cos_lat = cos(lat_r);
  if (sin_lat0 * sin_lat + cos_lat0 * cos_lat * cos(dlon) < 0)
    return false;
  out->x = (int)(L->map_w / 2 + L->globe_r * cos_lat * sin(dlon));
  out->y = (int)(L->globe_cy - L->globe_r * (cos_lat0 * sin_lat - sin_lat0 * cos_lat * cos(dlon)));
  return true;
}

typedef struct {
  double lon, lat;
} Origin;

static Origin view_origin(void) {
  if (s.has_location) {
    double lat = s.lat;
    if (lat > GLOBE_TILT_MAX)
      lat = GLOBE_TILT_MAX;
    else if (lat < -GLOBE_TILT_MAX)
      lat = -GLOBE_TILT_MAX;
    return (Origin){s.lon, lat};
  }
  return (Origin){-90, 15};
}

// ---------------------------------------------------------------- solar days

typedef struct {
  bool found;
  bool night;
  int64_t start, end;
  // Labels in UTC + offset, or the watch's own zone when !utc.
  bool utc;
  int32_t offset;
} Phase;

// Sunrise and sunset from sun_at when the forecast has none for now: the phone
// away for days, or the forecast service gone. Solar noon is when the subsolar
// longitude reaches the place; one correction step lands within a minute.
static SolarDay computed_solar_day(int32_t k, double lat, double lon) {
  double t = (k + 0.5 - lon / 360) * 86400000;
  Sun sun = sun_at((int64_t)t);
  t += (fmod(sun.lon - lon + 540, 360) - 180) * 240000;
  sun = sun_at((int64_t)t);
  const double lat_r = lat * PI / 180;
  const double dec_r = sun.lat * PI / 180;
  const double cos_h = (NIGHT_SIN - sin(lat_r) * sin(dec_r)) / (cos(lat_r) * cos(dec_r));
  SolarDay day = {k, 0, 0};
  // Polar day or night: no sunrise or sunset to draw.
  if (!(cos_h >= -1 && cos_h <= 1))
    return day;
  const double half = acos(cos_h) / PI * 43200000;
  day.sunrise = (int64_t)(t - half);
  day.sunset = (int64_t)(t + half);
  return day;
}

static struct {
  bool valid;
  int32_t k;
  double lat, lon;
  SolarDay days[3];
} s_computed;

static const SolarDay *computed_solar_days(int64_t now, double lat, double lon) {
  const int32_t k = (int32_t)floor((double)now / 86400000 + lon / 360);
  if (!s_computed.valid || s_computed.k != k || s_computed.lat != lat || s_computed.lon != lon) {
    for (int i = 0; i < 3; i++)
      s_computed.days[i] = computed_solar_day(k - 1 + i, lat, lon);
    s_computed.valid = true;
    s_computed.k = k;
    s_computed.lat = lat;
    s_computed.lon = lon;
  }
  return s_computed.days;
}

static Phase solar_phase_in(const SolarDay *days, int count, int64_t now) {
  Phase phase = {0};
  for (int i = 0; i < count; i++) {
    const SolarDay *day = &days[i];
    if (day->sunrise && day->sunset && day->sunrise <= now && now < day->sunset) {
      phase = (Phase){true, false, day->sunrise, day->sunset, false, 0};
      return phase;
    }
    const SolarDay *next = i + 1 < count ? &days[i + 1] : NULL;
    if (next && next->day == day->day + 1 && day->sunset && next->sunrise && day->sunset <= now &&
        now < next->sunrise) {
      phase = (Phase){true, true, day->sunset, next->sunrise, false, 0};
      return phase;
    }
  }
  return phase;
}

static Phase solar_phase_for(int64_t now) {
  Phase phase = {0};
  if (s.has_weather)
    phase = solar_phase_in(s.days, s.day_count, now);
  if (phase.found) {
    // Forecast times read in the forecast place's offset.
    phase.utc = true;
    phase.offset = s.utc_offset;
    return phase;
  }
  if (!s.has_location)
    return phase;
  phase = solar_phase_in(computed_solar_days(now, s.lat, s.lon), 3, now);
  // Forecast offsets are for the forecast place; otherwise show watch time.
  phase.utc = s.has_weather;
  phase.offset = s.has_weather ? s.utc_offset : 0;
  return phase;
}

// ---------------------------------------------------------------- text

static const char *const DAYS[] = {"SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"};
static const char *const MONTHS[] = {"JAN", "FEB", "MAR", "APR", "MAY", "JUN",
                                     "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"};

static bool hour12(void) {
  return !clock_is_24h_style();
}

static void format_time(char *out, size_t size, const struct tm *t) {
  if (hour12()) {
    int hours = t->tm_hour % 12;
    snprintf(out, size, "%d:%02d", hours ? hours : 12, t->tm_min);
  } else
    snprintf(out, size, "%02d:%02d", t->tm_hour, t->tm_min);
}

static void format_solar_time(char *out, size_t size, bool have, int64_t ms, bool utc,
                              int32_t offset) {
  if (!have) {
    snprintf(out, size, "--:--");
    return;
  }
  time_t t;
  struct tm *tm;
  if (utc) {
    t = (time_t)floor_div(ms + (int64_t)offset * 1000, 1000);
    tm = gmtime(&t);
  } else {
    t = (time_t)floor_div(ms, 1000);
    tm = localtime(&t);
  }
  const int hours = tm->tm_hour;
  const int minutes = tm->tm_min;
  if (hour12())
    snprintf(out, size, "%d:%02d%s", hours % 12 ? hours % 12 : 12, minutes, hours < 12 ? "a" : "p");
  else
    snprintf(out, size, "%02d:%02d", hours, minutes);
}

typedef struct {
  int left, right;
  bool night;
  bool has_x;
  int x;
  char start_text[16];
  char end_text[16];
} Ruler;

static Ruler solar_ruler(int64_t now, int w, const Phase *phase) {
  Ruler ruler;
  ruler.night = phase->found && phase->night;
  ruler.left = L->ruler_inset;
  ruler.right = w - L->ruler_inset - 1;
  ruler.has_x = phase->found;
  ruler.x = 0;
  if (phase->found)
    ruler.x = ruler.left + (int)js_round((double)(now - phase->start) /
                                          (double)(phase->end - phase->start) *
                                          (ruler.right - ruler.left));
  char start[8];
  char end[8];
  format_solar_time(start, sizeof(start), phase->found, phase->start, phase->utc, phase->offset);
  format_solar_time(end, sizeof(end), phase->found, phase->end, phase->utc, phase->offset);
  snprintf(ruler.start_text, sizeof(ruler.start_text), "%s%s", ruler.night ? "SET " : "RISE ",
           start);
  snprintf(ruler.end_text, sizeof(ruler.end_text), "%s%s", ruler.night ? "RISE " : "SET ", end);
  return ruler;
}

// ---------------------------------------------------------------- weather

enum { MOOD_NONE = -1, CLEAR, CLOUD, FOG, DRIZL, RAIN, SNOW, SHWR, STORM, MOON };

// Open-Meteo WMO weather interpretation codes.
static int mood_for(int code) {
  switch (code) {
    case 0: return CLEAR;
    case 1: case 2: case 3: return CLOUD;
    case 45: case 48: return FOG;
    case 51: case 53: case 55: case 56: case 57: return DRIZL;
    case 61: case 63: case 65: case 66: case 67: return RAIN;
    case 71: case 73: case 75: case 77: case 85: case 86: return SNOW;
    case 80: case 81: case 82: return SHWR;
    case 95: case 96: case 99: return STORM;
  }
  return MOOD_NONE;
}

// 16px monochrome pictograms, indexed by mood.
static const uint16_t WEATHER_ICONS[][16] = {
  [CLEAR] = {0x0180,0x0180,0x2004,0x1008,0x03c0,0x07e0,0x0ff0,0xcff3,0xcff3,0x0ff0,0x07e0,0x03c0,0x1008,0x2004,0x0180,0x0180},
  [CLOUD] = {0,0,0x03c0,0x07e0,0x0ff0,0x1ff8,0x7ffc,0xfffe,0xfffe,0xfffe,0x7ffc,0,0,0,0,0},
  [FOG] = {0,0x03c0,0x07e0,0x0ff0,0x3ffc,0x7ffe,0x3ffc,0,0,0x7ff8,0x7ff8,0,0x1ffe,0x1ffe,0,0},
  [RAIN] = {0,0x03c0,0x07e0,0x0ff0,0x3ffc,0x7ffe,0x7ffe,0x3ffc,0,0,0x1110,0x2220,0x4440,0,0x1110,0x2220},
  [SNOW] = {0,0,0x0180,0x2184,0x318c,0x1998,0x0db0,0x07e0,0x7ffe,0x07e0,0x0db0,0x1998,0x318c,0x2184,0x0180,0},
  [STORM] = {0,0x03c0,0x07e0,0x0ff0,0x3ffc,0x7ffe,0x7ffe,0x3ffc,0x0300,0x0600,0x0c00,0x1f80,0x0300,0x0600,0x0c00,0x0800},
  [MOON] = {0x03c0,0x0780,0x0f00,0x1e00,0x1e00,0x3c00,0x3c00,0x3c00,0x3e00,0x3e00,0x1f02,0x1f86,0x0ffe,0x07fc,0x03f8,0x00e0},
};

static const uint8_t MOON_PHASES[8][7] = {
  {0x1c, 0x22, 0x41, 0x41, 0x41, 0x22, 0x1c},
  {0x04, 0x0e, 0x0f, 0x0f, 0x0f, 0x0e, 0x04},
  {0x0c, 0x1e, 0x1f, 0x1f, 0x1f, 0x1e, 0x0c},
  {0x1c, 0x3e, 0x3f, 0x3f, 0x3f, 0x3e, 0x1c},
  {0x1c, 0x3e, 0x7f, 0x7f, 0x7f, 0x3e, 0x1c},
  {0x1c, 0x3e, 0x7e, 0x7e, 0x7e, 0x3e, 0x1c},
  {0x18, 0x3c, 0x7c, 0x7c, 0x7c, 0x3c, 0x18},
  {0x10, 0x38, 0x78, 0x78, 0x78, 0x38, 0x10},
};

static int icon_mood(int64_t now, const Phase *phase) {
  if (!s.has_weather)
    return MOOD_NONE;
  int mood = mood_for(s.code);
  if (mood == DRIZL || mood == SHWR)
    mood = RAIN;
  if (mood == CLEAR) {
    bool night;
    if (phase->found)
      night = phase->night;
    else {
      const Sun sun = sun_at(now);
      night = is_night_lon_lat(s.lon, s.lat, &sun);
    }
    if (night)
      mood = MOON;
  }
  return mood;
}

static int moon_phase_index(int64_t now) {
  // Meeus, Astronomical Algorithms: new moon JDE 2451550.1, synodic month.
  const double jd = (double)now / 86400000 + 2440587.5;
  double phase = (jd - 2451550.1) / 29.530588853;
  phase -= floor(phase);
  return (int)js_round(phase * 8) % 8;
}

// One rectangle per horizontal run of set bits; `scale` is the pixel size.
static void draw_bit_rows(GContext *ctx, const void *rows, bool wide, int count, int width, int x,
                          int y, int scale, uint8_t color) {
  const uint32_t top = 1u << (width - 1);
  for (int row = 0; row < count; row++) {
    const uint32_t bits = wide ? ((const uint16_t *)rows)[row] : ((const uint8_t *)rows)[row];
    int col = 0;
    while (col < width) {
      if (!(bits & (top >> col))) {
        col++;
        continue;
      }
      const int start = col;
      while (col < width && (bits & (top >> col)))
        col++;
      fill(ctx, color, x + start * scale, y + row * scale, (col - start) * scale, scale);
    }
  }
}

// ---------------------------------------------------------------- payload

// JavaScript Number() for the decimal fields the phone writes; NaN otherwise.
static double wire_number(const char *field, int len) {
  while (len > 0 && (*field == ' ' || *field == '\t')) {
    field++;
    len--;
  }
  while (len > 0 && (field[len - 1] == ' ' || field[len - 1] == '\t'))
    len--;
  if (len == 0)
    return NAN;
  int i = 0;
  bool negative = false;
  if (field[i] == '-' || field[i] == '+')
    negative = field[i++] == '-';
  uint64_t mantissa = 0;
  int digits = 0;
  int scale = 0;
  bool any = false;
  for (; i < len && is_digit(field[i]); i++, any = true) {
    if (digits < 19) {
      mantissa = mantissa * 10 + (field[i] - '0');
      if (mantissa)
        digits++;
    } else
      scale++;
  }
  if (i < len && field[i] == '.') {
    for (i++; i < len && is_digit(field[i]); i++, any = true) {
      if (digits < 19) {
        mantissa = mantissa * 10 + (field[i] - '0');
        if (mantissa)
          digits++;
        scale--;
      }
    }
  }
  if (!any)
    return NAN;
  if (i < len && (field[i] == 'e' || field[i] == 'E')) {
    i++;
    bool exp_negative = false;
    if (i < len && (field[i] == '-' || field[i] == '+'))
      exp_negative = field[i++] == '-';
    int exp = 0;
    bool exp_any = false;
    for (; i < len && is_digit(field[i]); i++, exp_any = true)
      if (exp < 10000)
        exp = exp * 10 + (field[i] - '0');
    if (!exp_any)
      return NAN;
    scale += exp_negative ? -exp : exp;
  }
  if (i != len)
    return NAN;
  // Exact for up to 15 digits and |scale| <= 22: one correctly rounded step.
  double value = (double)mantissa;
  double power = 1;
  for (int k = scale < 0 ? -scale : scale; k > 0; k--)
    power *= 10;
  value = scale < 0 ? value / power : value * power;
  return negative ? -value : value;
}

static int64_t weather_date(double seconds) {
  if (!isfinite(seconds) || seconds <= 0)
    return 0;
  return (int64_t)(seconds * 1000);
}

#define MAX_FIELDS 40

typedef struct {
  const char *at[MAX_FIELDS];
  int len[MAX_FIELDS];
  int count;
} Fields;

static void split_fields(const char *text, Fields *f) {
  f->count = 0;
  const char *start = text;
  for (const char *p = text;; p++) {
    if (*p == ',' || *p == 0) {
      if (f->count < MAX_FIELDS) {
        f->at[f->count] = start;
        f->len[f->count] = p - start;
        f->count++;
      }
      if (*p == 0)
        break;
      start = p + 1;
    }
  }
}

static double field_number(const Fields *f, int i) {
  return i < f->count ? wire_number(f->at[i], f->len[i]) : NAN;
}

static const int WEATHER_CODES[] = {0,  1,  2,  3,  45, 48, 51, 53, 55, 56, 57, 61, 63, 65,
                                    66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99};

// Fields from the phone's CSV payload: lat,lon,updatedAt,temp,code,utcOffset,
// then day,sunrise,sunset triples in Unix seconds.
static bool parse_weather(const Fields *f) {
  const double temp = field_number(f, 3);
  const double code = field_number(f, 4);
  bool known = false;
  for (unsigned k = 0; k < sizeof(WEATHER_CODES) / sizeof(WEATHER_CODES[0]); k++)
    if (code == WEATHER_CODES[k])
      known = true;
  if (!isfinite(temp) || !known)
    return false;
  // Unix timestamps remain UTC; only calendar-day matching uses the location offset.
  const double utc_offset = field_number(f, 5);
  const double offset = isfinite(utc_offset) ? utc_offset : 0;
  const double today = floor(((double)now_ms() / 1000 + offset) / 86400);
  s.day_count = 0;
  for (int i = 6; i < f->count && s.day_count < 4; i += 3) {
    const double time_s = field_number(f, i);
    if (!isfinite(time_s))
      continue;
    const double stamp = floor((time_s + offset) / 86400);
    // Retain yesterday's sunset for a fresh launch or refresh before dawn.
    if (stamp < today - 1)
      continue;
    SolarDay *day = &s.days[s.day_count++];
    day->day = (int32_t)stamp;
    day->sunrise = weather_date(field_number(f, i + 1));
    day->sunset = weather_date(field_number(f, i + 2));
  }
  // Already in the unit chosen in the phone settings.
  s.temp = (int)js_round(temp);
  s.code = (int)code;
  s.utc_offset = (int32_t)offset;
  s.has_weather = true;
  return true;
}

static bool valid_coordinates(double lat, double lon) {
  return isfinite(lat) && fabs(lat) <= 90 && isfinite(lon) && fabs(lon) <= 180;
}

// ---------------------------------------------------------------- storage

// The last good payload survives relaunches, so returning to the face does not
// wait on the phone; the theme too, so a relaunch paints in it at once.
enum { KEY_THEME = 1, KEY_PAYLOAD = 2, KEY_PAYLOAD_MORE = 3 };
#define PAYLOAD_MAX 500
#define PAYLOAD_PART (PERSIST_STRING_MAX_LENGTH - 1)

static char s_stored[PAYLOAD_MAX + 1];

static void store_payload(const char *text) {
  if (strcmp(text, s_stored) == 0 || strlen(text) > PAYLOAD_MAX)
    return;
  strncpy(s_stored, text, PAYLOAD_MAX);
  s_stored[PAYLOAD_MAX] = 0;
  char part[PAYLOAD_PART + 1];
  strncpy(part, text, PAYLOAD_PART);
  part[PAYLOAD_PART] = 0;
  persist_write_string(KEY_PAYLOAD, part);
  if (strlen(text) > PAYLOAD_PART)
    persist_write_string(KEY_PAYLOAD_MORE, text + PAYLOAD_PART);
  else if (persist_exists(KEY_PAYLOAD_MORE))
    persist_delete(KEY_PAYLOAD_MORE);
}

static void weather_failed(void) {
  if (!s.has_weather)
    s.status = OFFLINE;
  else if ((double)now_ms() - s.updated_at >= STALE_MS)
    s.status = STALE;
  if (!s.has_location)
    s_default_globe = true;
  mark_dirty();
}

static void apply_payload(const char *text) {
  static Fields f;
  split_fields(text, &f);
  if (f.count < 2) {
    weather_failed();
    return;
  }
  const double lat = field_number(&f, 0);
  const double lon = field_number(&f, 1);
  if (!valid_coordinates(lat, lon)) {
    weather_failed();
    return;
  }
  s.has_location = true;
  s.lat = lat;
  s.lon = lon;
  const bool had_weather = s.has_weather;
  s.has_weather = false;
  if (!parse_weather(&f)) {
    s.has_weather = had_weather;
    mark_dirty();
    weather_failed();
    return;
  }
  const double fetched_at = field_number(&f, 2);
  s.updated_at = isfinite(fetched_at) && fetched_at > 0 ? fetched_at : (double)now_ms();
  s.status = (double)now_ms() - s.updated_at >= STALE_MS ? STALE : READY;
  mark_dirty();
  store_payload(text);
}

static void restore_payload(void) {
  if (s.has_location || !persist_exists(KEY_PAYLOAD))
    return;
  persist_read_string(KEY_PAYLOAD, s_stored, PAYLOAD_PART + 1);
  if (persist_exists(KEY_PAYLOAD_MORE)) {
    const int used = strlen(s_stored);
    persist_read_string(KEY_PAYLOAD_MORE, s_stored + used, PAYLOAD_MAX + 1 - used);
  }
  if (s_stored[0]) {
    char text[PAYLOAD_MAX + 1];
    strncpy(text, s_stored, PAYLOAD_MAX);
    text[PAYLOAD_MAX] = 0;
    apply_payload(text);
  }
}

// ---------------------------------------------------------------- globe cache

// What the globe was last shaded for: a new place, a terminator step (half an
// hour), a new day of stars, a theme or a quick view shades it again, with the
// sun of that moment.
static struct {
  bool valid;
  Origin origin;
  int64_t step;
  int stars;
  bool has_sun;
  GPoint sun;
  bool has_pin;
  GPoint pin;
} s_globe;

static int lit_star_count(const struct tm *local) {
  const int n = local->tm_yday + 1;
  return n > STAR_N ? STAR_N : n;
}

static void draw_year_stars(GContext *ctx, const struct tm *local) {
  const int lit = lit_star_count(local);
  const int year = local->tm_year + 1900;
  const int leap = ((year % 4 == 0 && year % 100 != 0) || year % 400 == 0) ? 1 : 0;
  const int season[4] = {78 + leap, 171 + leap, 264 + leap, 354 + leap};
  const uint8_t *xs = s_round ? ROUND_STAR_X : STAR_X;
  const uint8_t *ys = s_round ? ROUND_STAR_Y : STAR_Y;
  const Theme *theme = &THEMES[s_theme];
  int next = 0;
  for (int i = 0; i < STAR_N; i++) {
    const bool is_season = next < 4 && season[next] == i;
    if (is_season)
      next++;
    else if (i >= lit) {
      // Past today only the season stars show: skip to the next one.
      if (next == 4)
        break;
      i = season[next] - 1;
      continue;
    }
    const uint8_t color = is_season ? theme->season : theme->star;
    const int x = xs[i];
    const int y = ys[i];
    switch (STAR_SHAPE[i]) {
      case 0: fill(ctx, color, x, y, 1, 1); break;
      case 1: fill(ctx, color, x, y, 2, 1); break;
      case 2:
        fill(ctx, color, x - 1, y, 3, 1);
        fill(ctx, color, x, y - 1, 1, 3);
        break;
      default: fill(ctx, color, x - 1, y - 1, 3, 3); break;
    }
  }
}

static void draw_sun_mark(GContext *ctx, int x, int y) {
  static const int8_t DOTS[8][2] = {{-3, -3}, {3, -3}, {-3, 3}, {3, 3},
                                    {-2, -2}, {2, -2}, {-2, 2}, {2, 2}};
  fill(ctx, BLACK, x - 4, y - 1, 9, 3);
  fill(ctx, BLACK, x - 1, y - 4, 3, 9);
  for (int i = 0; i < 8; i++)
    fill(ctx, BLACK, x + DOTS[i][0], y + DOTS[i][1], 1, 1);
  fill(ctx, YELLOW, x - 3, y, 7, 1);
  fill(ctx, YELLOW, x, y - 3, 1, 7);
  fill(ctx, YELLOW, x - 1, y - 1, 3, 3);
  for (int i = 0; i < 8; i++)
    fill(ctx, YELLOW, x + DOTS[i][0], y + DOTS[i][1], 1, 1);
}

static void draw_location_pin(GContext *ctx, int x, int y) {
  fill(ctx, BLACK, x - 2, y - 1, 5, 3);
  fill(ctx, BLACK, x - 1, y - 2, 3, 5);
  fill(ctx, WHITE, x - 1, y - 1, 3, 3);
}

static void shade_globe(int64_t now, Origin origin, int64_t step, int stars) {
  const Sun sun = sun_at(now);
  globe_shade(origin.lon, origin.lat, &sun);
  const double lat0 = origin.lat * PI / 180;
  const double sin_lat0 = sin(lat0);
  const double cos_lat0 = cos(lat0);
  const double lon0 = origin.lon * PI / 180;
  s_globe.has_sun = project_globe(sun.lon, sun.lat, lon0, sin_lat0, cos_lat0, &s_globe.sun);
  s_globe.has_pin = s.has_location &&
                    project_globe(s.lon, s.lat, lon0, sin_lat0, cos_lat0, &s_globe.pin);
  s_globe.valid = true;
  s_globe.origin = origin;
  s_globe.step = step;
  s_globe.stars = stars;
}

static void invalidate_globe(void) {
  s_globe.valid = false;
}

// ---------------------------------------------------------------- battery

// The charge sits in the sky, clear of the globe, as a small glyph over the
// number: in the top-right corner on Time 2, and on Round 2 beside the globe's
// right edge, where the circle leaves the room.
static BatteryChargeState s_battery;

#define BATTERY_LOW 20
#define BATTERY_BODY_W 13
#define BATTERY_BODY_H 7
#define BATTERY_W (BATTERY_BODY_W + 2)
#define BATTERY_GAP 3
// Gothic 14 Bold digit tops sit this far below the y draw_text is given.
#define BATTERY_TEXT_DY 4
#define BATTERY_TEXT_H 10
#define BATTERY_H (BATTERY_BODY_H + BATTERY_GAP + BATTERY_TEXT_H)

static void draw_battery_glyph(GContext *ctx, int x, int y, int percent, uint8_t ink,
                               uint8_t level) {
  fill(ctx, ink, x, y, BATTERY_BODY_W, 1);
  fill(ctx, ink, x, y + BATTERY_BODY_H - 1, BATTERY_BODY_W, 1);
  fill(ctx, ink, x, y + 1, 1, BATTERY_BODY_H - 2);
  fill(ctx, ink, x + BATTERY_BODY_W - 1, y + 1, 1, BATTERY_BODY_H - 2);
  fill(ctx, ink, x + BATTERY_BODY_W, y + 2, 2, BATTERY_BODY_H - 4);
  // A pixel of air between the outline and the charge on every side.
  const int inner = BATTERY_BODY_W - 4;
  int level_w = (percent * inner + 50) / 100;
  if (percent > 0 && level_w < 1)
    level_w = 1;
  if (level_w > 0)
    fill(ctx, level, x + 2, y + 2, level_w, BATTERY_BODY_H - 4);
}

static void draw_battery(GContext *ctx) {
  const Theme *theme = &THEMES[s_theme];
  int percent = s_battery.charge_percent;
  if (percent > 100)
    percent = 100;
  const bool low = percent <= BATTERY_LOW && !s_battery.is_charging;
  // Quiet until it matters: full ink when low, the theme's accent while charging.
  const uint8_t ink = low ? theme->star : theme->sky_muted;
  const uint8_t level = s_battery.is_charging ? theme->season : ink;
  char text[8];
  snprintf(text, sizeof(text), "%d%%", percent);
  const int text_w = tracked_width(text, &s_small_font);
  // The stack's center: right of the globe on Round 2 (half way to the
  // screen's edge), and inside the caption inset on Time 2.
  const int cx = s_round ? (L->map_w / 2 + L->globe_r + L->map_w - 11) / 2
                         : L->map_w - L->caption_inset - 16;
  const int top = s_round ? L->globe_cy - BATTERY_H / 2 : 7;
  const int glyph_x = cx - BATTERY_W / 2;
  const int glyph_y = top;
  const int text_x = cx - text_w / 2;
  const int text_y = top + BATTERY_BODY_H + BATTERY_GAP;
  // Clear the year stars from under it, with two pixels of margin.
  const int x0 = glyph_x < text_x ? glyph_x : text_x;
  const int x1 = glyph_x + BATTERY_W > text_x + text_w ? glyph_x + BATTERY_W : text_x + text_w;
  fill(ctx, theme->sky, x0 - 2, top - 2, x1 - x0 + 4, BATTERY_H + 4);
  draw_battery_glyph(ctx, glyph_x, glyph_y, percent, ink, level);
  draw_tracked(ctx, text, &s_small_font, ink, text_x, text_y - BATTERY_TEXT_DY);
}

static void battery_changed(BatteryChargeState charge) {
  s_battery = charge;
  mark_dirty();
}

// ---------------------------------------------------------------- drawing

static void draw_solar_dot(GContext *ctx, int x, int y) {
  const Theme *theme = &THEMES[s_theme];
  fill(ctx, theme->paper, x - 5, y - 5, 11, 11);
  fill(ctx, theme->ink, x - 3, y - 4, 7, 9);
  fill(ctx, theme->ink, x - 4, y - 3, 9, 7);
}

static void draw_solar_progress(GContext *ctx, const Ruler *ruler, int w) {
  const Theme *theme = &THEMES[s_theme];
  const int y = L->ruler_y;
  fill(ctx, theme->ink, ruler->left, y, ruler->right - ruler->left + 1, 1);
  fill(ctx, theme->ink, ruler->left, y - 3, 1, 7);
  fill(ctx, theme->ink, ruler->right, y - 3, 1, 7);
  if (ruler->has_x)
    draw_solar_dot(ctx, ruler->x, y);
  draw_tracked(ctx, ruler->start_text, &s_small_font, theme->ink, L->solar_label_inset,
               L->solar_label_y);
  draw_tracked(ctx, ruler->end_text, &s_small_font, theme->ink,
               w - L->solar_label_inset - tracked_width(ruler->end_text, &s_small_font),
               L->solar_label_y);
}

static void canvas_update(Layer *layer, GContext *ctx) {
  const Theme *theme = &THEMES[s_theme];
  const int64_t now = now_ms();
  const time_t now_s = (time_t)(now / 1000);
  struct tm local = *localtime(&now_s);
  const GRect bounds = layer_get_bounds(layer);
  const GRect open = layer_get_unobstructed_bounds(layer);
  const int w = open.size.w;
  const int h = open.size.h;
  // A timeline quick view on the round screen covers where the clock sits; lift
  // the HUD over the bottom of the globe so the clock stays visible above it.
  const int clock_h = L->caption_y - L->map_h;
  const int hud_y = L->map_h < h - clock_h ? L->map_h : h - clock_h;

  // Sky, globe and year stars.
  fill(ctx, theme->sky, 0, 0, L->map_w, L->map_h);
  if (s.has_location || s_default_globe) {
    const Origin origin = view_origin();
    const int64_t step = now / TERMINATOR_MS;
    const int stars = lit_star_count(&local);
    if (!s_globe.valid || s_globe.origin.lon != origin.lon || s_globe.origin.lat != origin.lat ||
        s_globe.step != step || s_globe.stars != stars)
      shade_globe(now, origin, step, stars);
    globe_draw(ctx);
    draw_year_stars(ctx, &local);
    if (s_globe.has_sun)
      draw_sun_mark(ctx, s_globe.sun.x, s_globe.sun.y);
    if (s_globe.has_pin)
      draw_location_pin(ctx, s_globe.pin.x, s_globe.pin.y);
  }
  draw_battery(ctx);

  // The HUD. Caption and ruler keep their rows under a quick view.
  fill(ctx, theme->paper, 0, hud_y, w, bounds.size.h - hud_y);

  char time_text[8];
  format_time(time_text, sizeof(time_text), &local);
  const int time_w = text_width(time_text, &s_time_font);
  const int time_x = (w - time_w) / 2;
  draw_text(ctx, time_text, &s_time_font, theme->ink, time_x, hud_y);
  if (hour12())
    draw_text(ctx, local.tm_hour < 12 ? "AM" : "PM", &s_small_font, theme->muted,
              time_x + time_w + 5, hud_y + 26);

  const Phase phase = solar_phase_for(now);
  const Ruler ruler = solar_ruler(now, w, &phase);
  const int mood = icon_mood(now, &phase);
  char date_text[16];
  snprintf(date_text, sizeof(date_text), "%s %s %d", DAYS[local.tm_wday], MONTHS[local.tm_mon],
           local.tm_mday);
  const bool stale = s.status == STALE;
  char weather_text[16];
  if (s.has_weather)
    snprintf(weather_text, sizeof(weather_text), "%d\xc2\xb0%s", s.temp, stale ? "!" : "");
  else
    snprintf(weather_text, sizeof(weather_text), "--\xc2\xb0");
  const uint8_t weather_ink = stale || !s.has_weather ? theme->muted : theme->ink;

  draw_tracked(ctx, date_text, &s_date_font, theme->ink, L->caption_inset, L->caption_y);
  draw_bit_rows(ctx, MOON_PHASES[moon_phase_index(now)], false, 7, 7,
                L->caption_inset + tracked_width(date_text, &s_date_font) + 8, L->caption_y + 3,
                2, theme->ink);
  const int weather_x = w - L->caption_inset - tracked_width(weather_text, &s_date_font);
  draw_tracked(ctx, weather_text, &s_date_font, weather_ink, weather_x, L->caption_y);
  if (mood != MOOD_NONE)
    draw_bit_rows(ctx, WEATHER_ICONS[mood], true, 16, 16, weather_x - 22, L->caption_y + 3, 1,
                  weather_ink);
  draw_solar_progress(ctx, &ruler, w);
}

// ---------------------------------------------------------------- events

static void apply_theme(int index, bool stored) {
  if (index < 0 || index >= THEME_COUNT || index == s_theme)
    return;
  s_theme = index;
  invalidate_globe();
  if (stored)
    return;
  mark_dirty();
  persist_write_int(KEY_THEME, index);
}

static void restore_theme(void) {
  if (persist_exists(KEY_THEME))
    apply_theme(persist_read_int(KEY_THEME), true);
}

enum { MSG_PAYLOAD_BYTES = 1024, MSG_OUT_BYTES = 64 };

static void inbox_received(DictionaryIterator *iter, void *context) {
  const Tuple *theme = dict_find(iter, MESSAGE_KEY_THEME);
  if (theme && (theme->type == TUPLE_INT || theme->type == TUPLE_UINT)) {
    int32_t value = 0;
    if (theme->length == 1)
      value = theme->type == TUPLE_INT ? theme->value->int8 : theme->value->uint8;
    else if (theme->length == 2)
      value = theme->type == TUPLE_INT ? theme->value->int16 : theme->value->uint16;
    else if (theme->length == 4)
      value = theme->value->int32;
    apply_theme(value, false);
  }
  const Tuple *payload = dict_find(iter, MESSAGE_KEY_PAYLOAD);
  // length counts the terminating NUL: more than one byte is a non-empty string.
  if (payload && payload->type == TUPLE_CSTRING && payload->length > 1)
    apply_payload(payload->value->cstring);
}

static void request_refresh(void) {
  if (!connection_service_peek_pebblekit_connection())
    return;
  DictionaryIterator *iter;
  if (app_message_outbox_begin(&iter) != APP_MSG_OK)
    return;
  dict_write_uint8(iter, MESSAGE_KEY_CMD, 1);
  app_message_outbox_send();
}

static void tick(struct tm *tick_time, TimeUnits units_changed) {
  if (s.has_weather && (double)now_ms() - s.updated_at >= STALE_MS)
    s.status = STALE;
  mark_dirty();
  if (units_changed & HOUR_UNIT)
    request_refresh();
}

static void unobstructed_change(AnimationProgress progress, void *context) {
  invalidate_globe();
  mark_dirty();
}

static void unobstructed_did_change(void *context) {
  invalidate_globe();
  mark_dirty();
}

static void default_globe_timer(void *data) {
  if (!s.has_location) {
    s_default_globe = true;
    mark_dirty();
  }
}

static void offline_timer(void *data) {
  if (!s.has_location)
    weather_failed();
}

static void window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  const GRect bounds = layer_get_bounds(root);
  s_round = bounds.size.w > 0 && bounds.size.w == bounds.size.h;
  L = s_round ? &LAYOUT_ROUND : &LAYOUT_RECT;
  globe_init(L->map_w, L->map_h, L->globe_cy, L->globe_r);
  s_canvas = layer_create(bounds);
  layer_set_update_proc(s_canvas, canvas_update);
  layer_add_child(root, s_canvas);
}

static void window_unload(Window *window) {
  layer_destroy(s_canvas);
  s_canvas = NULL;
}

static void init(void) {
  s.status = LOADING;
  s_time_font = (Font){fonts_get_system_font(FONT_KEY_BITHAM_42_BOLD), 9};
  s_date_font = (Font){fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD), 3};
  s_small_font = (Font){fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD), 3};
  restore_theme();
  restore_payload();
  s_battery = battery_state_service_peek();

  s_window = window_create();
  window_set_window_handlers(s_window, (WindowHandlers){.load = window_load, .unload = window_unload});
  window_stack_push(s_window, false);

  tick_timer_service_subscribe(MINUTE_UNIT, tick);
  battery_state_service_subscribe(battery_changed);
  unobstructed_area_service_subscribe(
      (UnobstructedAreaHandlers){.change = unobstructed_change, .did_change = unobstructed_did_change},
      NULL);
  app_message_register_inbox_received(inbox_received);
  app_message_open(MSG_PAYLOAD_BYTES, MSG_OUT_BYTES);
  app_timer_register(2000, default_globe_timer, NULL);
  app_timer_register(30000, offline_timer, NULL);
}

static void deinit(void) {
  tick_timer_service_unsubscribe();
  battery_state_service_unsubscribe();
  window_destroy(s_window);
}

int main(void) {
  init();
  app_event_loop();
  deinit();
}
