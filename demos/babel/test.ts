export async function main() {
  await new Promise(r => setTimeout(r, 1000));
  console.log('hello!');

  let a = await new Promise(r => r('a'));
  console.log(a);
}
