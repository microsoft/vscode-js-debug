require('ts-node').register({ transpileModule: true })

const { double } = require('./double.ts');

console.log(double(21));
