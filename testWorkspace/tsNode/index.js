const tsn = require('ts-node');

tsn.register({ transpileModule: true });

const { double, triple } = require('./double.ts');

console.log(triple(3));
console.log(double(21));

require('./matching-line.ts');
require('./log.ts');
