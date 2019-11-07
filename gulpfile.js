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
const tslint = require('gulp-tslint');
const typescript = require('typescript');
const vsce = require('vsce');
const webpack = require('webpack');
const execSync = require('child_process').execSync;

const dirname = 'vscode-node-debug3';
const extensionId = 'vscode-pwa';
const translationProjectName = 'vscode-extensions';
const translationExtensionName = 'vscode-node-debug';

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

const replaceNamespace = () => replace(/NAMESPACE\((.*?)\)/g, `${namespace}$1`);
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
      sourcemaps.write('../out', {
        includeContent: false,
        sourceRoot: '.',
      }),
    )
    .pipe(gulp.dest('out')),
);

gulp.task(
  'compile:static',
  gulp.parallel(
    () =>
      gulp
        .src('*.json')
        .pipe(replaceNamespace())
        .pipe(gulp.dest('out')),
    () =>
      gulp
        .src('src/**/*.sh')
        .pipe(replaceNamespace())
        .pipe(gulp.dest('out/src')),
  ),
);

gulp.task('compile', gulp.parallel('compile:ts', 'compile:static'));

/** Run webpack to bundle the extension output files */
gulp.task('bundle', async () => {
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
      externals: {
        vscode: 'commonjs vscode',
      },
    };

    if (library) {
      config.output.libraryTarget = 'commonjs2';
    }

    await new Promise((resolve, reject) => webpack(config, (err, stats) => {
      if (err) {
        reject(err);
      } else if (stats.hasErrors()) {
        reject(stats);
      } else {
        resolve();
      }
    }));
  }
});


// TODO: check the output location of watchdog/bootloader make sure it will work in out/src
/** Flatten the bundle files so that extension, bootloader, and watchdog are all at the root */
gulp.task('flatten-bundle-files',
  () => {
    const source = `${distSrcDir}/${nodeTargetsDir}/*.js`;
    const base = `${distSrcDir}/${nodeTargetsDir}`;
    const dest = distSrcDir;
    return gulp.src(source, { base })
        .pipe(gulp.dest(dest));
  }
);

/** Copy the built package.json files */
gulp.task('copy-extension-files', () => {
  return gulp.src([
    `${buildDir}/package.json`,
    `${buildDir}/package.nls.json`,
  ], { base: buildDir }).pipe(
    gulp.dest(distDir)
  );
});

/** Copy resources and any other files from outside of the `out` directory */
gulp.task('copy-resources', () =>
  gulp.src([`resources`, `resources/**/*`, 'LICENSE'], { base: '.' })
      .pipe(gulp.dest(distDir))
);

/** Clean up the node targets dir in dist */
gulp.task('bundle-cleanup', () => del(`${distSrcDir}/${nodeTargetsDir}`));

/** Create a VSIX package using the vsce command line tool */
gulp.task('createVSIX', () => {
  return runCommand(`${ path.join('..', 'node_modules', '.bin', 'vsce')} package --yarn -o ${extensionId}.vsix`, { stdio: 'inherit', cwd: distDir });
});

/** Clean, compile, bundle, and create vsix for the extension */
gulp.task('package',
  gulp.series(
    'clean',
    'compile',
    'bundle',
    'copy-extension-files',
    'copy-resources',
    'flatten-bundle-files',
    'bundle-cleanup',
    'createVSIX')
);

gulp.task(
  'publish',
  gulp.series('package', () =>
    vsce.publish({
      ...minimist(process.argv.slice(2)),
      cwd: 'out',
    }),
  ),
);

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
    } catch(err) {
      reject(err);
    }
    resolve();
  });
}