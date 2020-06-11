"use strict";
function bar() {
    foo();
}
bar();
//# sourceMappingURL=exceptionBp.js.map

function foo() {
  throw new Error('oh no!');
}
