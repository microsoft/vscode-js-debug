/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

const path = require('path');
const config = JSON.parse(process.env.CONFIG);
const webpack = require('webpack');

for (const rule of config.module.rules) {
  if (typeof rule.test === 'string') {
    rule.test = new RegExp(rule.test);
  }
}

if (process.env.ANALYZE_SIZE === 'true') {
  config.plugins.push(
    new (require('webpack-bundle-analyzer').BundleAnalyzerPlugin)({
      analyzerMode: 'static',
      reportFilename: path.resolve(__dirname, '../../dist/', path.basename(config.entry) + '.html'),
    }),
  );
}

if (process.env.USE_VSCODE_L10N === 'true') {
  config.plugins.push(
    new webpack.NormalModuleReplacementPlugin(/common\/l10n(.js)?$/, './l10n.extensionOnly.js'),
  );
}

const compiler = webpack(config);

const handleResult = (err, stats) => {
  if (err) {
    console.error(err);
    return false;
  }

  if (stats.hasErrors()) {
    console.error(stats.toString({ colors: true }));
    return false;
  }

  return true;
};

if (process.env.WATCH === 'true') {
  compiler.watch({ aggregateTimeout: 1000 }, (err, stats) => {
    handleResult(err, stats);
    console.log('Bundled', path.basename(config.entry), `in ${stats.endTime - stats.startTime}ms`);
  });
} else {
  compiler.run((err, stats) => {
    process.exit(handleResult(err, stats) ? 0 : 1);
  });
}
