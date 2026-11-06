// A stand-in for the Pebble SDK's pebble.h, just wide enough for src/c, so
// the watchface compiles on the host. tests/c/mock.c implements it: drawing
// is recorded, and time, storage, messages and timers are driven by a script.
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <time.h>

// Watch time comes from the script.
time_t mock_time(time_t *out);
#define time(out) mock_time(out)

#define APP_LOG(level, ...) ((void)0)

typedef union GColor8 {
  uint8_t argb;
} GColor8;
typedef GColor8 GColor;

typedef struct GPoint {
  int16_t x, y;
} GPoint;
typedef struct GSize {
  int16_t w, h;
} GSize;
typedef struct GRect {
  GPoint origin;
  GSize size;
} GRect;
#define GRect(x, y, w, h) ((GRect){{(x), (y)}, {(w), (h)}})

typedef enum { GCornerNone = 0 } GCornerMask;
typedef enum {
  GTextOverflowModeWordWrap,
  GTextOverflowModeTrailingEllipsis,
  GTextOverflowModeFill
} GTextOverflowMode;
typedef enum { GTextAlignmentLeft, GTextAlignmentCenter, GTextAlignmentRight } GTextAlignment;
typedef struct GTextAttributes GTextAttributes;
typedef struct GContext GContext;
typedef struct MockFont *GFont;

#define FONT_KEY_BITHAM_42_BOLD "RESOURCE_ID_BITHAM_42_BOLD"
#define FONT_KEY_GOTHIC_18_BOLD "RESOURCE_ID_GOTHIC_18_BOLD"
#define FONT_KEY_GOTHIC_14_BOLD "RESOURCE_ID_GOTHIC_14_BOLD"
GFont fonts_get_system_font(const char *font_key);

void graphics_context_set_fill_color(GContext *ctx, GColor color);
void graphics_context_set_text_color(GContext *ctx, GColor color);
void graphics_fill_rect(GContext *ctx, GRect rect, uint16_t corner_radius, GCornerMask mask);
void graphics_draw_text(GContext *ctx, const char *text, GFont const font, const GRect box,
                        const GTextOverflowMode overflow_mode, const GTextAlignment alignment,
                        GTextAttributes *text_attributes);
GSize graphics_text_layout_get_content_size(const char *text, GFont const font, const GRect box,
                                            const GTextOverflowMode overflow_mode,
                                            const GTextAlignment alignment);

typedef struct Layer Layer;
typedef struct Window Window;
typedef void (*LayerUpdateProc)(Layer *layer, GContext *ctx);
typedef void (*WindowHandler)(Window *window);
typedef struct WindowHandlers {
  WindowHandler load;
  WindowHandler appear;
  WindowHandler disappear;
  WindowHandler unload;
} WindowHandlers;

Layer *layer_create(GRect frame);
void layer_destroy(Layer *layer);
void layer_set_update_proc(Layer *layer, LayerUpdateProc update_proc);
void layer_add_child(Layer *parent, Layer *child);
void layer_mark_dirty(Layer *layer);
GRect layer_get_bounds(const Layer *layer);
GRect layer_get_unobstructed_bounds(const Layer *layer);
Window *window_create(void);
void window_destroy(Window *window);
void window_set_window_handlers(Window *window, WindowHandlers handlers);
void window_stack_push(Window *window, bool animated);
Layer *window_get_root_layer(const Window *window);

typedef enum {
  SECOND_UNIT = 1 << 0,
  MINUTE_UNIT = 1 << 1,
  HOUR_UNIT = 1 << 2,
  DAY_UNIT = 1 << 3,
  MONTH_UNIT = 1 << 4,
  YEAR_UNIT = 1 << 5,
} TimeUnits;
typedef void (*TickHandler)(struct tm *tick_time, TimeUnits units_changed);
void tick_timer_service_subscribe(TimeUnits tick_units, TickHandler handler);
void tick_timer_service_unsubscribe(void);
bool clock_is_24h_style(void);

typedef struct AppTimer AppTimer;
typedef void (*AppTimerCallback)(void *data);
AppTimer *app_timer_register(uint32_t timeout_ms, AppTimerCallback callback, void *callback_data);

typedef int32_t AnimationProgress;
typedef void (*UnobstructedAreaWillChangeHandler)(GRect final_unobstructed_screen_area,
                                                  void *context);
typedef void (*UnobstructedAreaChangeHandler)(AnimationProgress progress, void *context);
typedef void (*UnobstructedAreaDidChangeHandler)(void *context);
typedef struct {
  UnobstructedAreaWillChangeHandler will_change;
  UnobstructedAreaChangeHandler change;
  UnobstructedAreaDidChangeHandler did_change;
} UnobstructedAreaHandlers;
void unobstructed_area_service_subscribe(UnobstructedAreaHandlers handlers, void *context);

bool connection_service_peek_pebblekit_connection(void);

typedef struct {
  uint8_t charge_percent;
  bool is_charging;
  bool is_plugged;
} BatteryChargeState;
typedef void (*BatteryStateHandler)(BatteryChargeState charge);
BatteryChargeState battery_state_service_peek(void);
void battery_state_service_subscribe(BatteryStateHandler handler);
void battery_state_service_unsubscribe(void);

#define PERSIST_DATA_MAX_LENGTH 256
#define PERSIST_STRING_MAX_LENGTH PERSIST_DATA_MAX_LENGTH
typedef int32_t status_t;
bool persist_exists(const uint32_t key);
int32_t persist_read_int(const uint32_t key);
status_t persist_write_int(const uint32_t key, const int32_t value);
int persist_read_string(const uint32_t key, char *buffer, const size_t buffer_size);
int persist_write_string(const uint32_t key, const char *cstring);
status_t persist_delete(const uint32_t key);

typedef enum { TUPLE_BYTE_ARRAY = 0, TUPLE_CSTRING = 1, TUPLE_UINT = 2, TUPLE_INT = 3 } TupleType;
typedef union {
  uint8_t uint8;
  uint16_t uint16;
  uint32_t uint32;
  int8_t int8;
  int16_t int16;
  int32_t int32;
  char cstring[1024];
} MockTupleValue;
typedef struct {
  uint32_t key;
  TupleType type;
  uint16_t length;
  MockTupleValue value[1];
} Tuple;
typedef struct DictionaryIterator DictionaryIterator;
typedef enum { DICT_OK = 0 } DictionaryResult;
typedef enum { APP_MSG_OK = 0, APP_MSG_BUSY = 64 } AppMessageResult;
typedef void (*AppMessageInboxReceived)(DictionaryIterator *iterator, void *context);
Tuple *dict_find(const DictionaryIterator *iter, const uint32_t key);
DictionaryResult dict_write_uint8(DictionaryIterator *iter, const uint32_t key, const uint8_t value);
AppMessageInboxReceived app_message_register_inbox_received(AppMessageInboxReceived handler);
AppMessageResult app_message_open(const uint32_t size_inbound, const uint32_t size_outbound);
AppMessageResult app_message_outbox_begin(DictionaryIterator **iterator);
AppMessageResult app_message_outbox_send(void);

// package.json messageKeys, in order.
#define MESSAGE_KEY_PAYLOAD 10000
#define MESSAGE_KEY_CMD 10001
#define MESSAGE_KEY_THEME 10002

void app_event_loop(void);
