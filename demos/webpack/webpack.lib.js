const path = require('path');

module.exports = {
  target: 'node',
  mode: 'development',
  devtool: 'source-map',
  entry: './src/lib.ts',
  module: {
    rules: [
      {
        loader: 'ts-loader',
        exclude: /node_modules/,
      },
    ],
  },
  node: {
    __dirname: false,
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
  output: {
    filename: 'lib.js',
    path: path.resolve(__dirname, 'out'),
    library: 'lib',
    libraryTarget: 'umd',
  },
};
