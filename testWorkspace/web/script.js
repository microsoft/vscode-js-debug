function foo() {
  bar();
}

function bar() {
  console.log('here');
}

foo(3);
debugger;
foo();
