async function bar() {
  return 42;
}

async function foo() {
  const result = await bar();
  console.log(result + 1);
}

console.log('Hello world!');

var path = './.vscode/launch.json:4';
console.log(path);
var obj = {foo: path};
console.log(obj);
var arr = [path, obj];
console.log(arr);
foo();
