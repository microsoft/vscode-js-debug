require('@babel/register')({
  presets: [
    [
      '@babel/preset-env',
      {
        targets: { node: 'current' },
      },
    ],
  ],
  plugins: ['@babel/plugin-transform-typescript'],
  extensions: ['.ts', '.js'],
  cache: true,
});

const { main } = require('./test.ts');
main();
