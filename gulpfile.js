/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

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

const dirname = 'vscode-node-debug3';
const extensionId = 'node-debug3';
const translationProjectName = 'vscode-extensions';
const translationExtensionName = 'vscode-node-debug';

const sources = ['src/**/*.ts'];
const tslintFilter = ['**', '!**/*.d.ts'];
const allPackages = [];

/**
 * If --drop-in is set, commands and debug types will be set to 'chrome' and
 * 'node', rendering them incompatible with the base debuggers. Useful
 * to only set this to true to publish, and develop as namespaced extensions.
 */
const namespace = process.argv.includes('--drop-in') ? '' : 'pwa-';

const replaceNamespace = () => replace(/NAMESPACE\((.*?)\)/g, `${namespace}$1`);
const tsProject = ts.createProject('./src/tsconfig.json', { typescript });
const tslintOptions = {
  formatter: 'prose',
  rulesDirectory: 'node_modules/tslint-microsoft-contrib',
};

gulp.task('clean', () =>
  del(['out/**', 'dist/**', 'src/*/package.nls.*.json', 'packages/**', '*.vsix']),
);

gulp.task(
  'compile',
  gulp.parallel(
    () =>
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
        .pipe(gulp.dest('out/out')),
    () =>
      gulp
        .src('*.json')
        .pipe(replaceNamespace())
        .pipe(gulp.dest('out')),
  ),
);

gulp.task('package', () =>
  gulp.series('clean', 'compile', () =>
    vsce.createVSIX({
      ...minimist(process.argv.slice(2)),
      cwd: 'out',
      packagePath: path.join(__dirname, 'out', `${extensionId}.vsix`),
    }),
  ),
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
      .src([
        'out/package.json',
        'out/nls.metadata.header.json',
        'out/nls.metadata.json',
      ])
      .pipe(nls.createXlfFiles(translationProjectName, translationExtensionName))
      .pipe(gulp.dest(path.join('..', 'vscode-translations-export'))),
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
