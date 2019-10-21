const path = require('path');

module.exports = {
  devtool: 'source-map',
  entry: './src/index.js',
  output: {
    path: path.join(__dirname, 'out'),
    filename: 'index.js',
  },
  target: 'node',
  mode: 'development',
};
