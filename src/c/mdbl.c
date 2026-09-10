#include <pebble.h>

int main(void) {
  Window *w = window_create();
  window_stack_push(w, true);

#ifdef PBL_DEBUG
  // Built with `pebble build --debug`: enable the xsbug JavaScript debugger.
  ModdableCreationRecord cr = {
    .recordSize = sizeof(cr),
    .stack = 6144,
    .slot = 24576,
    .chunk = 24576, // All three pools must be explicit; reserve native RAM for maps/Bluetooth.
    .flags = kModdableCreationFlagDebug,
  };
  moddable_createMachine(&cr);
#else
  ModdableCreationRecord cr = {
    .recordSize = sizeof(cr),
    .stack = 6144,
    .slot = 24576,
    .chunk = 24576, // All three pools must be explicit; reserve native RAM for maps/Bluetooth.
    .flags = kModdableCreationFlagLogInstrumentation,
  };
  moddable_createMachine(&cr);
#endif

  window_destroy(w);
}
