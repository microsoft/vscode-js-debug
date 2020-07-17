const tsn = require('ts-node');

tsn.register({
  transpileModule: true,
  compilerOptions: { sourceRoot: __dirname.replace(/\\/g, '/') },
});

const { double } = require('./double.ts');

console.log(double(21));
