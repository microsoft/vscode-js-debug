function plusTwo(num: number) {
    return num + 2;
}

function printArr(arr: number[]) {
    for(const num of arr) {
        console.log(plusTwo(num));
    }
}

function abcdef(): void {
    var obj1 = {
        a: 1,
        b: 2,
        c: " "
    }
    console.log("hello!");
    printArr([obj1.a, obj1.b]);
}

abcdef();