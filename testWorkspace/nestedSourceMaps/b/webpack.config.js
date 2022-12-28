const path = require('path');

module.exports = {
  entry: path.join(__dirname, 'lib.js'),
  mode: 'development',
  devtool: 'inline-source-map',
  output: {
    path: __dirname,
    filename: 'lib.bundle.js',
    library: { type: 'module' },
  },
  experiments: {
    outputModule: true,
  },
};
