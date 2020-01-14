require('ts-node').register({ transpileModule: true })

const { double, triple } = require('./double.ts');

console.log(triple(3));
console.log(double(21));

require('./log.ts');
