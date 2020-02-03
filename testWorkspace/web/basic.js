"use strict";
function plusTwo(num) {
    return num + 2;
}
function printArr(arr) {
    for (const num of arr) {
        console.log(plusTwo(num));
    }
}
function abcdef() {
    var obj1 = {
        a: 1,
        b: 2,
        c: " "
    };
    console.log("hello!");
    printArr([obj1.a, obj1.b]);
}
abcdef();
//# sourceMappingURL=basic.js.map