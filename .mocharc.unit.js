module.exports = {
  require: ['source-map-support/register', './out/src/test/testHooks'],
  spec: 'out/src/**/*.test.js',
  ignore: ['out/src/test/**/*.js'],
};
