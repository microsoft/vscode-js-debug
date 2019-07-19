(function(){function r(e,n,t){function o(i,f){if(!n[i]){if(!e[i]){var c="function"==typeof require&&require;if(!f&&c)return c(i,!0);if(u)return u(i,!0);var a=new Error("Cannot find module '"+i+"'");throw a.code="MODULE_NOT_FOUND",a}var p=n[i]={exports:{}};e[i][0].call(p.exports,function(r){var n=e[i][1][r];return o(n||r)},p,p.exports,r,e,n,t)}return n[i].exports}for(var u="function"==typeof require&&require,i=0;i<t.length;i++)o(t[i]);return o}return r})()({1:[function(require,module,exports){
"use strict";
exports.__esModule = true;
exports.kModule1 = 1;
function foo() {
    debugger;
}
exports.foo = foo;
function throwError(s) {
    throw new Error(s);
}
exports.throwError = throwError;
function throwValue(v) {
    throw v;
}
exports.throwValue = throwValue;

},{}],2:[function(require,module,exports){
"use strict";
exports.__esModule = true;
exports.kModule2 = 2;
function bar(callback) {
    callback();
}
exports.bar = bar;
function pause() {
    debugger;
}
exports.pause = pause;

},{}],3:[function(require,module,exports){
"use strict";
exports.__esModule = true;
var m1 = require("./module1");
var m2 = require("./module2");
m2.bar(m1.foo);

},{"./module1":1,"./module2":2}]},{},[3])
//# sourceMappingURL=pause.js.map
