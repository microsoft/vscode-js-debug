module.exports = {
  require: ['source-map-support/register', './src/test/testHooks.ts'],
  spec: 'src/**/*.test.ts',
  ignore: ['src/test/**/*.ts'],
};
