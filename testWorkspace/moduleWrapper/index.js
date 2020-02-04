// Hook into Node's require to add the module wrapper code. Normally we don't
// see this in the debugger, but some environments like Electron seem to
// include it, so this lets us have a test case for it.
// https://nodejs.org/api/modules.html#modules_the_module_wrapper
const fs = require('fs');
const extension = '.js';
const previous = require.extensions[extension];

require.extensions[extension] = (module, fname) => {
  const contents = fs.readFileSync(fname, 'utf8');
  const wrapped = `(function (exports, require, module, __filename, __dirname) { ${contents}\n});`;
  module._compile(wrapped, fname);
};

require('./test');
debugger; // make sure it runs long enough for us to get the event :P
