async function bar() {
  return 42;
}

async function foo() {
  const result = await bar();
  console.log(result + 1);
}

console.log('Hello world!');
foo();
