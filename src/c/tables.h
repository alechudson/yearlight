#pragma once
#include <stdint.h>

// Constant data, kept in flash: nothing is decoded at launch.

#define MASK_W 200
#define MASK_H 100
// Land bit for mask cell (x, y): WORLD_MASK[i >> 3] >> (i & 7) & 1, i = y * MASK_W + x.
extern const uint8_t WORLD_MASK[MASK_W * MASK_H / 8];

#define STAR_N 365
// Year stars in fill order, for the Time 2 sky; shape 0=dot 1=pair 2=cross 3=diamond.
extern const uint8_t STAR_X[STAR_N];
extern const uint8_t STAR_Y[STAR_N];
extern const uint8_t STAR_SHAPE[STAR_N];
// The same stars laid out for the Round 2 sky.
extern const uint8_t ROUND_STAR_X[STAR_N];
extern const uint8_t ROUND_STAR_Y[STAR_N];
