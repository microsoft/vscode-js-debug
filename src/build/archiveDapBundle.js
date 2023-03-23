const cp = require('child_process');
const path = require('path');
const packageJson = require('../../package.json');
const targetDirectory = process.argv[2];

require('fs').mkdirSync(targetDirectory, { recursive: true });

cp.spawnSync(
  'tar',
  [
    '-czvf',
    `${targetDirectory}/js-debug-dap-v${packageJson.version}.tar.gz`,
    'dist',
    '--transform',
    's/^dist/js-debug/',
  ],
  {
    stdio: 'inherit',
    cwd: path.resolve(__dirname, '../..'),
  },
);
