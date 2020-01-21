"use strict";

var a = 0;

function foo() {
  console.log(a);
  a++;
  console.log(a);
}

foo();

//# sourceMappingURL=babel.js.map

/* Original via `babel test.ts --source-maps --plugins @babel/plugin-transform-typescript --presets @babel/preset-env`:

let a = 0;

function foo() {
  console.log(a);
  a++;
  console.log(a);
}

foo();

*/
