const compiled =
  `"use strict";

console.log('hello world');
//# sourceMappingURL=data:application/json;charset=utf-8;base64,` +
  Buffer.from(
    JSON.stringify({
      version: 3,
      sources: ['test.js'],
      names: ['console', 'log'],
      mappings: ';;AAAAA,OAAO,CAACC,GAAR,CAAY,aAAZ',
      sourceRoot: __dirname,
      sourcesContent: ["console.log('hello world');\n"],
    }),
  ).toString('base64');

const fs = require('fs');
const path = require('path');
const extension = '.js';
const previous = require.extensions[extension];

require.extensions[extension] = (module, fname) => {
  module._compile(
    fname === path.join(__dirname, 'test.js') ? compiled : fs.readFileSync(fname, 'utf8'),
    fname,
  );
};

require('./test');
