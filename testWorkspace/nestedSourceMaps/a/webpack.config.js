const path = require('path');

module.exports = {
  entry: path.join(__dirname, 'main.js'),
  mode: 'development',
  devtool: 'inline-source-map',
  output: {
    path: __dirname,
    filename: 'main.bundle.js',
  },
};
