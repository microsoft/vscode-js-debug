const fs = require('fs');
const extension = '.js';
const previous = require.extensions[extension];

require.extensions[extension] = (module, fname) => {
  const contents = fs.readFileSync(fname, 'utf8');
  const wrapped = `(function (myCustomWrapper) { ${contents}\n});`;
  module._compile(wrapped, fname);
};

require('./test');
debugger; // make sure it runs long enough for us to get the event :P
