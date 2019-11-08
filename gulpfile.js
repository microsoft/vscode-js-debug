// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

const del = require('del');
const filter = require('gulp-filter');
const gulp = require('gulp');
const minimist = require('minimist');
const nls = require('vscode-nls-dev');
const path = require('path');
const replace = require('gulp-replace');
const sourcemaps = require('gulp-sourcemaps');
const ts = require('gulp-typescript');
const rename = require('gulp-rename');
const merge = require('merge2');
const tslint = require('gulp-tslint');
const typescript = require('typescript');
const vsce = require('vsce');
const webpack = require('webpack');
const execSync = require('child_process').execSync;

const dirname = 'js-debug';
const translationProjectName = 'vscode-extensions';
const translationExtensionName = 'js-debug';

const sources = ['src/**/*.ts'];
const tslintFilter = ['**', '!**/*.d.ts'];
const allPackages = [];

const buildDir = 'out';
const buildSrcDir = `${buildDir}/src`;
const distDir = 'dist';
const distSrcDir = `${distDir}/src`;
const nodeTargetsDir = `targets/node`;

/**
 * If --drop-in is set, commands and debug types will be set to 'chrome' and
 * 'node', rendering them incompatible with the base debuggers. Useful
 * to only set this to true to publish, and develop as namespaced extensions.
 */
const namespace = process.argv.includes('--drop-in') ? '' : 'pwa-';

/**
 * Extension ID to build. Appended with '-nightly' as necessary.
 */
const extensionId = process.argv.includes('--nightly') ? 'js-debug-nightly' : 'js-debug';

const replaceNamespace = () => replace(/NAMESPACE\((.*?)\)/g, `${namespace}$1`);
const replaceNightly = () => replace('js-debug', extensionId);
const tsProject = ts.createProject('./tsconfig.json', { typescript });
const tslintOptions = {
  formatter: 'prose',
  rulesDirectory: 'node_modules/tslint-microsoft-contrib',
};

gulp.task('clean', () =>
  del(['out/**', 'dist/**', 'src/*/package.nls.*.json', 'packages/**', '*.vsix']),
);

gulp.task('compile:ts', () =>
  tsProject
    .src()
    .pipe(sourcemaps.init())
    .pipe(replaceNamespace())
    .pipe(tsProject())
    .js.pipe(
      sourcemaps.write('.', {
        includeContent: false,
        sourceRoot: '.',
      }),
    )
    .pipe(gulp.dest('out/src')),
);

gulp.task('compile:static', () =>
  merge(gulp.src('*.json'), gulp.src('src/**/*.sh', { base: '.' }))
    .pipe(replaceNamespace())
    .pipe(replaceNightly())
    .pipe(gulp.dest('out')),
);

gulp.task('compile', gulp.parallel('compile:ts', 'compile:static'));

/** Run webpack to bundle the extension output files */
gulp.task('package:webpack-bundle', async () => {
  const packages = [
    { entry: `${buildSrcDir}/extension.js`, library: true },
    { entry: `${buildSrcDir}/${nodeTargetsDir}/bootloader.js`, library: false },
    { entry: `${buildSrcDir}/${nodeTargetsDir}/watchdog.js`, library: false },
  ];

  for (const { entry, library } of packages) {
    const config = {
      mode: 'production',
      target: 'node',
      entry: path.resolve(entry),
      output: {
        path: path.resolve(distSrcDir),
        filename: path.basename(entry),
        devtoolModuleFilenameTemplate: '../[resource-path]',
      },
      node: {
        __dirname: false,
        __filename: false,
      },
      externals: {
        vscode: 'commonjs vscode',
      },
    };

    if (library) {
      config.output.libraryTarget = 'commonjs2';
    }

    await new Promise((resolve, reject) =>
      webpack(config, (err, stats) => {
        if (err) {
          reject(err);
        } else if (stats.hasErrors()) {
          reject(stats);
        } else {
          resolve();
        }
      }),
    );
  }
});

/** Copy the extension static files */
gulp.task('package:copy-extension-files', () =>
  merge(
    gulp.src([`${buildDir}/package.json`, `${buildDir}/package.nls.json`, 'LICENSE']),
    gulp.src('resources/**/*', { base: '.' }),
    gulp.src(`src/**/*.sh`).pipe(rename({ dirname: 'src' })),
  ).pipe(gulp.dest(distDir)),
);

/** Create a VSIX package using the vsce command line tool */
gulp.task('package:createVSIX', () =>
  vsce.createVSIX({
    cwd: distDir,
    useYarn: true,
    packagePath: path.join(distDir, `${extensionId}.vsix`),
  }),
);

/** Clean, compile, bundle, and create vsix for the extension */
gulp.task(
  'package',
  gulp.series(
    'clean',
    'compile',
    'package:webpack-bundle',
    'package:copy-extension-files',
    'package:createVSIX',
  ),
);

/** Publishes the build extension to the marketplace */
gulp.task('publish:vsce', () =>
  vsce.publish({
    pat: process.env.MARKETPLACE_TOKEN,
    cwd: distDir,
  }),
);

gulp.task('publish', gulp.series('package', 'publish:vsce'));
gulp.task('default', gulp.series('compile'));

gulp.task(
  'watch',
  gulp.series('clean', 'compile', done => {
    gulp.watch([...sources, '*.json'], gulp.series('compile'));
    done();
  }),
);

gulp.task(
  'nls-bundle-create',
  gulp.series('compile', () =>
    tsProject
      .src()
      .pipe(sourcemaps.init())
      .pipe(tsProject())
      .js.pipe(nls.createMetaDataFiles())
      .pipe(nls.bundleMetaDataFiles(`ms-vscode.${extensionId}`, 'out'))
      .pipe(nls.bundleLanguageFiles())
      .pipe(filter('**/nls.*.json'))
      .pipe(gulp.dest('out')),
  ),
);

gulp.task(
  'translations-export',
  gulp.series('clean', 'compile', 'nls-bundle-create', () =>
    gulp
      .src(['out/package.json', 'out/nls.metadata.header.json', 'out/nls.metadata.json'])
      .pipe(nls.createXlfFiles(translationProjectName, translationExtensionName))
      .pipe(gulp.dest(`../vscode-translations-export`)),
  ),
);

gulp.task('format', () =>
  gulp
    .src(sources)
    .pipe(filter(tslintFilter))
    .pipe(tslint({ ...tslintOptions, fix: true }))
    .pipe(tslint.report({ emitError: false }))
    .pipe(gulp.dest('./src')),
);

gulp.task('lint', () =>
  gulp
    .src(sources)
    .pipe(filter(tslintFilter))
    .pipe(tslint(tslintOptions))
    .pipe(tslint.report()),
);

/**
 * Run a command in the terminal using exec, and wrap it in a promise
 * @param {string} cmd The command line command + args to execute
 * @param {ExecOptions} options, see here for options: https://nodejs.org/docs/latest-v10.x/api/child_process.html#child_process_child_process_exec_command_options_callback
 */
function runCommand(cmd, options) {
  return new Promise((resolve, reject) => {
    let execError = undefined;
    try {
      execSync(cmd, { stdio: 'inherit', ...options });
    } catch (err) {
      reject(err);
    }
    resolve();
  });
}
