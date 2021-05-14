function test() {
  const outer = 1;
  if (outer) {
    const inner1 = 2;
    const inner2 = 3;
    hitDebugger(inner1, inner2);
  }

  const later = 4;
  hitDebugger(later);

  function hitDebugger(arg1, arg2) {
    debugger;
  }
}
