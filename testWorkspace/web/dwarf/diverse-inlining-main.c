#define INLINE __attribute__((noinline))
#include "diverse-inlining.h"

extern int bar(int);

int main(int argc, char** argv) {
  argc = foo(argc);
  argc = bar(argc);
  return argc;
}
