#define INLINE __attribute__((always_inline))
#include "diverse-inlining.h"

int bar(int x) {
  return foo(x);
}

