async function foo(): Promise<number> {
  let x = 1;
  return x + 3;
}

async function main(): Promise<void> {
  debugger;
  const z = await foo();
}

main();
