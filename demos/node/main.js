console.log('hi');console.log('hi2');
async function bar() {
  return 42;
}

async function foo() {
  const result = await bar();
  console.log(result + 1);
}

function throwIt() {
  setTimeout(() => {
    throw new Error('Oh my!');
  }, 0);
}

let counter = 0;
setInterval(() => {
  setTimeout(() => {
    //console.log("a\nb\nc\nd" + (++counter));
  }, 0);
}, 2000);

console.log('Hello world!');

var path = './.vscode/launch.json:4:2';
console.log(path);
var obj = {foo: path};
console.log(obj);
var arr = [path, obj];
console.log(arr);
foo();
