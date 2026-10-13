#include <pebble.h>

int main(void) {
  Window *w = window_create();
  window_stack_push(w, true);

#ifdef PBL_DEBUG
  // Built with `pebble build --debug`: enable the xsbug JavaScript debugger.
  ModdableCreationRecord cr = {
    .recordSize = sizeof(cr),
    .stack = 6144,
    .slot = 28672, // Launch peaks between 25600 and 26624 (emulator, 1.0.9).
    .chunk = 22528, // Runs at 18432; all three pools must be explicit. Same 50 KB total as 26624/24576.
    .flags = kModdableCreationFlagDebug,
  };
  moddable_createMachine(&cr);
#else
  ModdableCreationRecord cr = {
    .recordSize = sizeof(cr),
    .stack = 6144,
    .slot = 28672, // Launch peaks between 25600 and 26624 (emulator, 1.0.9).
    .chunk = 22528, // Runs at 18432; all three pools must be explicit. Same 50 KB total as 26624/24576.
    .flags = 0,
  };
  moddable_createMachine(&cr);
#endif

  window_destroy(w);
}
