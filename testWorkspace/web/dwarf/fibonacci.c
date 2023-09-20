#include <stdio.h>

int fib(int n) {
  int a, b = 0, c = 1;
  for (int i = 1; i < n; ++i) {
    a = b;
    b = c;
    c = a + b;
  }
  return c;
}

int main() {
  int a = fib(9);
  printf("9th fib: %d\n", a);
  int b = fib(5);
  printf("5th fib: %d\n", b);
  return 0;
}
