const crypto = require('crypto');
const micromatch = require('micromatch');

function doBusyWork() {
  let n = 0;
  for (let i = 0; i < 10; i++) {
    const input = crypto.randomBytes(8).toString('hex');
    for (let i = 0; i < 200; i++) {
      n += micromatch([input], [`${i}*`]).length;
    }
  }

  return n;
}

const noop = () => {
  console.log('do nothing');
};

setInterval(() => {
  const start = Date.now();
  const busyStuff = doBusyWork();
  console.log('hello');
}, 100);
