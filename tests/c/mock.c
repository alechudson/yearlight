// Host implementation of tests/c/pebble.h, driven by a script on stdin.
//
// Preamble, before the app starts (read on the first SDK call):
//   size W H | now UNIX_S | hour12 0|1 | connected 0|1 | battery PERCENT CHARGING
//   persist_int KEY VALUE | persist_str KEY TEXT... | persist_data KEY HEX | start
// Then, one per line:
//   now UNIX_S         set the clock
//   tick               minute tick (HOUR_UNIT when the hour changed)
//   timers             fire app timers that are due
//   msg THEME PAYLOAD  inbox message; "-" leaves a key out
//   obstruct H         unobstructed height (quick view), H = screen for none
//   battery P C        battery event: P percent, C charging 0|1
//   frame              render and print {"rects":[[argb,x,y,w,h]...],"texts":[[text,size,argb,x,y]...]}
//   persist            print the persist store and how many writes the app made
//   sent               print the number of outbox messages sent
#include <pebble.h>

#include <stdlib.h>

struct MockFont {
  int size;
};
static struct MockFont s_fonts[3] = {{42}, {18}, {14}};

struct Layer {
  GRect frame;
  LayerUpdateProc update;
  bool dirty;
};
struct Window {
  WindowHandlers handlers;
  Layer root;
};

static int s_w = 200, s_h = 228, s_open_h = 228;
static int64_t s_now_ms;
static bool s_hour12;
static bool s_connected = true;
static bool s_setup_done;
static Layer *s_layers[8];
static int s_layer_count;
static TickHandler s_tick;
static struct tm s_last_tick;
static UnobstructedAreaHandlers s_unobstructed;
static void *s_unobstructed_context;
static AppMessageInboxReceived s_inbox;
static int s_sent;
static BatteryChargeState s_battery = {80, false, false};
static BatteryStateHandler s_battery_handler;

// ------------------------------------------------------------ persist

typedef struct {
  bool used;
  uint32_t key;
  bool is_int;
  bool is_data;
  int32_t value;
  char text[PERSIST_STRING_MAX_LENGTH];
  int size;
} Slot;
#define SLOTS 32
static Slot s_persist[SLOTS];
static int s_persist_writes;

static Slot *slot(uint32_t key, bool create) {
  for (int i = 0; i < SLOTS; i++)
    if (s_persist[i].used && s_persist[i].key == key)
      return &s_persist[i];
  if (!create)
    return NULL;
  for (int i = 0; i < SLOTS; i++)
    if (!s_persist[i].used) {
      memset(&s_persist[i], 0, sizeof(Slot));
      s_persist[i].used = true;
      s_persist[i].key = key;
      return &s_persist[i];
    }
  return NULL;
}

bool persist_exists(const uint32_t key) { return slot(key, false) != NULL; }

int32_t persist_read_int(const uint32_t key) {
  Slot *p = slot(key, false);
  return p && p->is_int ? p->value : 0;
}

status_t persist_write_int(const uint32_t key, const int32_t value) {
  s_persist_writes++;
  Slot *p = slot(key, true);
  p->is_int = true;
  p->value = value;
  return 4;
}

int persist_read_string(const uint32_t key, char *buffer, const size_t buffer_size) {
  Slot *p = slot(key, false);
  if (!p || p->is_int || p->is_data || buffer_size == 0)
    return -1;
  strncpy(buffer, p->text, buffer_size - 1);
  buffer[buffer_size - 1] = 0;
  return strlen(buffer) + 1;
}

int persist_write_string(const uint32_t key, const char *cstring) {
  if (strlen(cstring) + 1 > PERSIST_STRING_MAX_LENGTH)
    return -1;
  s_persist_writes++;
  Slot *p = slot(key, true);
  p->is_int = false;
  p->is_data = false;
  strcpy(p->text, cstring);
  return strlen(cstring) + 1;
}

int persist_read_data(const uint32_t key, void *buffer, const size_t buffer_size) {
  Slot *p = slot(key, false);
  if (!p || !p->is_data)
    return -1;
  const int n = (int)buffer_size < p->size ? (int)buffer_size : p->size;
  memcpy(buffer, p->text, n);
  return n;
}

int persist_write_data(const uint32_t key, const void *data, const size_t size) {
  if (size > PERSIST_DATA_MAX_LENGTH)
    return -1;
  s_persist_writes++;
  Slot *p = slot(key, true);
  p->is_int = false;
  p->is_data = true;
  memcpy(p->text, data, size);
  p->size = size;
  return size;
}

static int hex_digit(char c) {
  return c <= '9' ? c - '0' : (c | 0x20) - 'a' + 10;
}

status_t persist_delete(const uint32_t key) {
  Slot *p = slot(key, false);
  if (p)
    p->used = false;
  return 0;
}

// ------------------------------------------------------------ script

static char *trim_line(char *line) {
  line[strcspn(line, "\r\n")] = 0;
  return line;
}

static void setup(void) {
  if (s_setup_done)
    return;
  s_setup_done = true;
  char line[2048];
  while (fgets(line, sizeof(line), stdin)) {
    trim_line(line);
    if (strcmp(line, "start") == 0)
      break;
    int a, b;
    long long t;
    if (sscanf(line, "size %d %d", &a, &b) == 2) {
      s_w = a;
      s_h = s_open_h = b;
    } else if (sscanf(line, "now %lld", &t) == 1)
      s_now_ms = t * 1000;
    else if (sscanf(line, "hour12 %d", &a) == 1)
      s_hour12 = a;
    else if (sscanf(line, "connected %d", &a) == 1)
      s_connected = a;
    else if (sscanf(line, "battery %d %d", &a, &b) == 2)
      s_battery = (BatteryChargeState){a, b, b};
    else if (sscanf(line, "persist_int %d %d", &a, &b) == 2)
      persist_write_int(a, b);
    else if (strncmp(line, "persist_data ", 13) == 0) {
      char *rest = line + 13;
      char *space = strchr(rest, ' ');
      if (space) {
        *space = 0;
        uint8_t data[PERSIST_DATA_MAX_LENGTH];
        int n = 0;
        for (char *h = space + 1; h[0] && h[1] && n < (int)sizeof(data); h += 2)
          data[n++] = hex_digit(h[0]) << 4 | hex_digit(h[1]);
        persist_write_data(atoi(rest), data, n);
      }
    } else if (strncmp(line, "persist_str ", 12) == 0) {
      char *rest = line + 12;
      char *space = strchr(rest, ' ');
      if (space) {
        *space = 0;
        persist_write_string(atoi(rest), space + 1);
      }
    }
  }
  s_persist_writes = 0;
  time_t now = s_now_ms / 1000;
  s_last_tick = *localtime(&now);
}

time_t mock_time(time_t *out) {
  setup();
  time_t now = (time_t)(s_now_ms / 1000);
  if (out)
    *out = now;
  return now;
}

bool clock_is_24h_style(void) { return !s_hour12; }
bool connection_service_peek_pebblekit_connection(void) { return s_connected; }

BatteryChargeState battery_state_service_peek(void) {
  setup();
  return s_battery;
}
void battery_state_service_subscribe(BatteryStateHandler handler) { s_battery_handler = handler; }
void battery_state_service_unsubscribe(void) { s_battery_handler = NULL; }

// ------------------------------------------------------------ fonts and drawing

GFont fonts_get_system_font(const char *key) {
  setup();
  if (strcmp(key, FONT_KEY_BITHAM_42_BOLD) == 0)
    return &s_fonts[0];
  if (strcmp(key, FONT_KEY_GOTHIC_18_BOLD) == 0)
    return &s_fonts[1];
  return &s_fonts[2];
}

static GColor s_fill, s_text;
static bool s_recording;
static int s_rect_count, s_text_count;

static void json_string(const char *text) {
  putchar('"');
  for (const char *p = text; *p; p++) {
    if (*p == '"' || *p == '\\')
      putchar('\\');
    putchar(*p);
  }
  putchar('"');
}

void graphics_context_set_fill_color(GContext *ctx, GColor color) { s_fill = color; }
void graphics_context_set_text_color(GContext *ctx, GColor color) { s_text = color; }

void graphics_fill_rect(GContext *ctx, GRect r, uint16_t corner_radius, GCornerMask mask) {
  if (!s_recording)
    return;
  printf("%s[%d,%d,%d,%d,%d]", s_rect_count++ ? "," : "", s_fill.argb, r.origin.x, r.origin.y,
         r.size.w, r.size.h);
}

// Like the JS tests' Poco: every code point is ceil(size / 2) wide.
static int width_of(const char *text, GFont font) {
  int points = 0;
  for (const unsigned char *p = (const unsigned char *)text; *p; p++)
    if ((*p & 0xC0) != 0x80)
      points++;
  return points * ((font->size + 1) / 2);
}

static char s_texts[64][128];
static int s_text_x[64], s_text_y[64], s_text_size[64], s_text_color[64];

void graphics_draw_text(GContext *ctx, const char *text, GFont const font, const GRect box,
                        const GTextOverflowMode overflow_mode, const GTextAlignment alignment,
                        GTextAttributes *text_attributes) {
  if (!s_recording || s_text_count >= 64)
    return;
  const int i = s_text_count++;
  strncpy(s_texts[i], text, 127);
  s_texts[i][127] = 0;
  s_text_x[i] = box.origin.x;
  s_text_y[i] = box.origin.y;
  s_text_size[i] = font->size;
  s_text_color[i] = s_text.argb;
}

GSize graphics_text_layout_get_content_size(const char *text, GFont const font, const GRect box,
                                            const GTextOverflowMode overflow_mode,
                                            const GTextAlignment alignment) {
  return (GSize){width_of(text, font), font->size};
}

// ------------------------------------------------------------ layers and windows

Layer *layer_create(GRect frame) {
  Layer *layer = calloc(1, sizeof(Layer));
  layer->frame = frame;
  if (s_layer_count < 8)
    s_layers[s_layer_count++] = layer;
  return layer;
}

void layer_destroy(Layer *layer) {
  for (int i = 0; i < s_layer_count; i++)
    if (s_layers[i] == layer)
      s_layers[i] = NULL;
  free(layer);
}

void layer_set_update_proc(Layer *layer, LayerUpdateProc update) { layer->update = update; }
void layer_add_child(Layer *parent, Layer *child) {}
void layer_mark_dirty(Layer *layer) { layer->dirty = true; }
GRect layer_get_bounds(const Layer *layer) { return GRect(0, 0, layer->frame.size.w, layer->frame.size.h); }
GRect layer_get_unobstructed_bounds(const Layer *layer) {
  return GRect(0, 0, layer->frame.size.w, s_open_h < layer->frame.size.h ? s_open_h : layer->frame.size.h);
}

static Window s_window;
Window *window_create(void) {
  setup();
  s_window.root.frame = GRect(0, 0, s_w, s_h);
  return &s_window;
}
void window_destroy(Window *window) {}
void window_set_window_handlers(Window *window, WindowHandlers handlers) { window->handlers = handlers; }
void window_stack_push(Window *window, bool animated) {
  if (window->handlers.load)
    window->handlers.load(window);
}
Layer *window_get_root_layer(const Window *window) { return (Layer *)&window->root; }

// ------------------------------------------------------------ services

void tick_timer_service_subscribe(TimeUnits units, TickHandler handler) { s_tick = handler; }
void tick_timer_service_unsubscribe(void) { s_tick = NULL; }

void unobstructed_area_service_subscribe(UnobstructedAreaHandlers handlers, void *context) {
  s_unobstructed = handlers;
  s_unobstructed_context = context;
}

typedef struct {
  bool active;
  int64_t due;
  AppTimerCallback callback;
  void *data;
} Timer;
static Timer s_timers[16];

AppTimer *app_timer_register(uint32_t timeout_ms, AppTimerCallback callback, void *data) {
  for (int i = 0; i < 16; i++)
    if (!s_timers[i].active) {
      s_timers[i] = (Timer){true, s_now_ms + timeout_ms, callback, data};
      return (AppTimer *)&s_timers[i];
    }
  return NULL;
}

static void run_timers(void) {
  for (;;) {
    int best = -1;
    for (int i = 0; i < 16; i++)
      if (s_timers[i].active && s_timers[i].due <= s_now_ms &&
          (best < 0 || s_timers[i].due < s_timers[best].due))
        best = i;
    if (best < 0)
      return;
    s_timers[best].active = false;
    s_timers[best].callback(s_timers[best].data);
  }
}

struct DictionaryIterator {
  Tuple tuples[4];
  int count;
};
static DictionaryIterator s_inbox_iter, s_outbox_iter;

Tuple *dict_find(const DictionaryIterator *iter, const uint32_t key) {
  for (int i = 0; i < iter->count; i++)
    if (iter->tuples[i].key == key)
      return (Tuple *)&iter->tuples[i];
  return NULL;
}

DictionaryResult dict_write_uint8(DictionaryIterator *iter, const uint32_t key, const uint8_t value) {
  Tuple *t = &iter->tuples[iter->count++];
  t->key = key;
  t->type = TUPLE_UINT;
  t->length = 1;
  t->value->uint8 = value;
  return DICT_OK;
}

AppMessageInboxReceived app_message_register_inbox_received(AppMessageInboxReceived handler) {
  s_inbox = handler;
  return handler;
}
AppMessageResult app_message_open(const uint32_t in, const uint32_t out) { return APP_MSG_OK; }
AppMessageResult app_message_outbox_begin(DictionaryIterator **iterator) {
  s_outbox_iter.count = 0;
  *iterator = &s_outbox_iter;
  return APP_MSG_OK;
}
AppMessageResult app_message_outbox_send(void) {
  s_sent++;
  return APP_MSG_OK;
}

// ------------------------------------------------------------ the loop

static void frame(void) {
  printf("{\"rects\":[");
  s_recording = true;
  s_rect_count = s_text_count = 0;
  for (int i = 0; i < s_layer_count; i++)
    if (s_layers[i] && s_layers[i]->update) {
      s_layers[i]->update(s_layers[i], NULL);
      s_layers[i]->dirty = false;
    }
  s_recording = false;
  printf("],\"texts\":[");
  for (int i = 0; i < s_text_count; i++) {
    printf(i ? ",[" : "[");
    json_string(s_texts[i]);
    printf(",%d,%d,%d,%d]", s_text_size[i], s_text_color[i], s_text_x[i], s_text_y[i]);
  }
  printf("]}\n");
}

static void dump_persist(void) {
  printf("{\"persist\":[");
  bool first = true;
  for (int i = 0; i < SLOTS; i++) {
    if (!s_persist[i].used)
      continue;
    printf(first ? "[%u," : ",[%u,", s_persist[i].key);
    first = false;
    if (s_persist[i].is_int)
      printf("%d]", s_persist[i].value);
    else if (s_persist[i].is_data) {
      printf("{\"data\":\"");
      for (int k = 0; k < s_persist[i].size; k++)
        printf("%02x", (uint8_t)s_persist[i].text[k]);
      printf("\"}]");
    }
    else {
      json_string(s_persist[i].text);
      printf("]");
    }
  }
  printf("],\"writes\":%d}\n", s_persist_writes);
}

void app_event_loop(void) {
  setup();
  char line[2048];
  while (fgets(line, sizeof(line), stdin)) {
    trim_line(line);
    long long t;
    int h, b;
    if (sscanf(line, "now %lld", &t) == 1)
      s_now_ms = t * 1000;
    else if (strcmp(line, "tick") == 0) {
      time_t now = s_now_ms / 1000;
      struct tm local = *localtime(&now);
      TimeUnits units = MINUTE_UNIT;
      if (local.tm_hour != s_last_tick.tm_hour || local.tm_yday != s_last_tick.tm_yday)
        units |= HOUR_UNIT;
      s_last_tick = local;
      if (s_tick)
        s_tick(&local, units);
    } else if (strcmp(line, "timers") == 0)
      run_timers();
    else if (strncmp(line, "msg ", 4) == 0) {
      char *theme = line + 4;
      char *payload = strchr(theme, ' ');
      if (payload)
        *payload++ = 0;
      s_inbox_iter.count = 0;
      if (strcmp(theme, "-") != 0) {
        Tuple *tuple = &s_inbox_iter.tuples[s_inbox_iter.count++];
        tuple->key = MESSAGE_KEY_THEME;
        tuple->type = TUPLE_INT;
        tuple->length = 4;
        tuple->value->int32 = atoi(theme);
      }
      if (payload && strcmp(payload, "-") != 0) {
        Tuple *tuple = &s_inbox_iter.tuples[s_inbox_iter.count++];
        tuple->key = MESSAGE_KEY_PAYLOAD;
        tuple->type = TUPLE_CSTRING;
        strncpy(tuple->value->cstring, payload, sizeof(tuple->value->cstring) - 1);
        tuple->length = strlen(tuple->value->cstring) + 1;
      }
      if (s_inbox)
        s_inbox(&s_inbox_iter, NULL);
    } else if (sscanf(line, "obstruct %d", &h) == 1) {
      s_open_h = h;
      if (s_unobstructed.change)
        s_unobstructed.change(0, s_unobstructed_context);
      if (s_unobstructed.did_change)
        s_unobstructed.did_change(s_unobstructed_context);
    } else if (sscanf(line, "battery %d %d", &h, &b) == 2) {
      s_battery = (BatteryChargeState){h, b, b};
      if (s_battery_handler)
        s_battery_handler(s_battery);
    } else if (strcmp(line, "frame") == 0)
      frame();
    else if (strcmp(line, "persist") == 0)
      dump_persist();
    else if (strcmp(line, "sent") == 0)
      printf("{\"sent\":%d}\n", s_sent);
    fflush(stdout);
  }
}
