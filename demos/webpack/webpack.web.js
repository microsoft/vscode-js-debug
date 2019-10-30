const path = require('path');

module.exports = {
  devtool: 'source-map',
  entry: './src/index.js',
  output: {
    path: path.join(__dirname, 'out'),
    filename: 'web.js',
  },
  mode: 'development',
};
