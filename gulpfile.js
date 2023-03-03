/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

const del = require('del');
const filter = require('gulp-filter');
const gulp = require('gulp');
const minimist = require('minimist');
const path = require('path');
const rename = require('gulp-rename');
const merge = require('merge2');
const vsce = require('vsce');
const execSync = require('child_process').execSync;
const fs = require('fs');
const cp = require('child_process');
const util = require('util');
const deepmerge = require('deepmerge');
const esbuild = require('esbuild');
const esbuildPlugins = require('./src/build/esbuildPlugins');

const dirname = 'js-debug';
const sources = ['src/**/*.{ts,tsx}'];
const allPackages = [];

const srcDir = 'src';
const buildDir = 'dist';
const buildSrcDir = `${buildDir}/src`;
const nodeTargetsDir = `targets/node`;

const isWatch = process.argv.includes('watch') || process.argv.includes('--watch');

/**
 * Whether we're running a nightly build.
 */
const isNightly = process.argv.includes('--nightly') || isWatch;

/**
 * Extension ID to build. Appended with '-nightly' as necessary.
 */
const extensionName = isNightly ? 'js-debug-nightly' : 'js-debug';

async function runBuildScript(name) {
  return new Promise((resolve, reject) =>
    cp.execFile(
      process.execPath,
      [path.join(__dirname, buildDir, 'src', 'build', name)],
      (err, stdout, stderr) => {
        process.stderr.write(stderr);
        if (err) {
          return reject(err);
        }

        const outstr = stdout.toString('utf-8');
        try {
          resolve(JSON.parse(outstr));
        } catch {
          resolve(outstr);
        }
      },
    ),
  );
}

const writeFile = util.promisify(fs.writeFile);
const readFile = util.promisify(fs.readFile);

async function readJson(file) {
  const contents = await readFile(path.join(__dirname, file), 'utf-8');
  return JSON.parse(contents);
}

gulp.task('clean-assertions', () => del(['src/test/**/*.txt.actual']));

gulp.task('clean', () => del(['dist/**', 'src/*/package.nls.*.json', 'packages/**', '*.vsix']));

async function fixNightlyReadme() {
  const readmePath = `${buildDir}/README.md`;
  const readmeText = await readFile(readmePath);
  const readmeNightlyText = await readFile(`README.nightly.md`);

  await writeFile(readmePath, readmeNightlyText + '\n' + readmeText);
}

const getVersionNumber = () => {
  if (process.env.JS_DEBUG_VERSION) {
    return process.env.JS_DEBUG_VERSION;
  }

  const date = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const monthMinutes = (date.getDate() - 1) * 24 * 60 + date.getHours() * 60 + date.getMinutes();

  return [
    // YY
    date.getFullYear(),
    // MM,
    date.getMonth() + 1,
    //DDHH
    `${date.getDate()}${String(date.getHours()).padStart(2, '0')}`,
  ].join('.');
};

const cachedBuilds = new Map();
const incrementalEsbuild = async (/** @type {esbuild.BuildOptions} */ options) => {
  const key = JSON.stringify(options);
  if (cachedBuilds.has(key)) {
    return cachedBuilds.get(key).rebuild();
  }

  if (!isWatch) {
    const r = await esbuild.build(options);
    if (r.metafile) {
      console.log(await esbuild.analyzeMetafile(r.metafile));
    }
    return;
  }

  const ctx = await esbuild.context(options);
  cachedBuilds.set(key, ctx);

  await ctx.rebuild();
};

gulp.task('compile:build-scripts', () =>
  incrementalEsbuild({
    entryPoints: fs
      .readdirSync('src/build')
      .filter(f => f.endsWith('.ts'))
      .map(f => `src/build/${f}`),
    outdir: `${buildDir}/src/build`,
    bundle: true,
    platform: 'node',
  }),
);

gulp.task('compile:dynamic', async () => {
  const [contributions, strings] = await Promise.all([
    runBuildScript('generate-contributions'),
    runBuildScript('documentReadme'),
  ]);

  let packageJson = await readJson('package.json');
  packageJson.name = extensionName;
  if (isNightly) {
    packageJson.displayName += ' (Nightly)';
    packageJson.version = getVersionNumber();
    packageJson.preview = true;
    await fixNightlyReadme();
  }

  packageJson = deepmerge(packageJson, contributions);

  return Promise.all([
    writeFile(`${buildDir}/package.json`, JSON.stringify(packageJson)),
    writeFile(`${buildDir}/package.nls.json`, JSON.stringify(strings)),
  ]);
});

gulp.task('compile:static', () =>
  merge(
    gulp.src(
      [
        'LICENSE',
        'resources/**/*',
        'README.md',
        'package.nls.json',
        'src/**/*.sh',
        '.vscodeignore',
      ],
      {
        base: '.',
      },
    ),
    gulp
      .src(['node_modules/source-map/lib/*.wasm', 'node_modules/@c4312/chromehash/pkg/*.wasm'])
      .pipe(rename({ dirname: 'src' })),
  ).pipe(gulp.dest(buildDir)),
);

const resolveDefaultExts = ['.tsx', '.ts', '.jsx', '.js', '.css', '.json'];

async function compileTs({
  packages = [],
  sourcemap = false,
  compileInPlace = false,
  minify = isWatch ? false : true,
  watch = false,
} = options) {
  // add the entrypoints common to both vscode and vs here
  packages = [
    ...packages,
    { entry: `${srcDir}/common/hash/hash.ts`, library: false },
    { entry: `${srcDir}/targets/node/bootloader.ts`, library: false },
    { entry: `${srcDir}/targets/node/watchdog.ts`, library: false },
    { entry: `${srcDir}/diagnosticTool/diagnosticTool.tsx`, library: false, target: 'browser' },
  ];

  let todo = [];
  for (const { entry, target = 'node', library, isInVsCode, nodePackages } of packages) {
    todo.push(
      incrementalEsbuild({
        entryPoints: [entry],
        platform: target,
        bundle: true,
        outdir: buildSrcDir,
        resolveExtensions: isInVsCode
          ? ['.extensionOnly.ts', ...resolveDefaultExts]
          : resolveDefaultExts,
        external: isInVsCode ? ['vscode'] : [],
        sourcemap: !!sourcemap,
        sourcesContent: false,
        packages: nodePackages,
        minify,
        alias: target === 'node' ? {} : { path: 'path-browserify' },
        plugins: [
          esbuildPlugins.nativeNodeModulesPlugin(),
          esbuildPlugins.importGlobLazy(),
          esbuildPlugins.dirname(/src.test./),
        ],
        format: library ? 'cjs' : 'iife',
      }),
    );
  }

  await Promise.all(todo);
}

/** Run webpack to bundle the extension output files */
gulp.task('compile:extension', async () => {
  const packages = [
    { entry: `${srcDir}/extension.ts`, library: true, isInVsCode: true },
    {
      entry: `${srcDir}/test/testRunner.ts`,
      library: true,
      isInVsCode: true,
      nodePackages: 'external',
    },
  ];
  return compileTs({ packages, sourcemap: true });
});

gulp.task(
  'compile',
  gulp.series('compile:static', 'compile:build-scripts', 'compile:dynamic', 'compile:extension'),
);

/** Run webpack to bundle into the flat session launcher (for VS or standalone debug server)  */
gulp.task('flatSessionBundle:webpack-bundle', async () => {
  const packages = [{ entry: `${srcDir}/flatSessionLauncher.ts`, library: true }];
  return compileTs({ packages, sourcemap: true });
});

gulp.task('package:bootloader-as-cdp', done => {
  const bootloaderFilePath = path.resolve(buildSrcDir, 'bootloader.js');
  fs.appendFile(bootloaderFilePath, '\n//# sourceURL=bootloader.bundle.cdp', done);
});

/** Run webpack to bundle into the VS debug server */
gulp.task('vsDebugServerBundle:webpack-bundle', async () => {
  const packages = [{ entry: `${srcDir}/vsDebugServer.ts`, library: true }];
  return compileTs({ packages, sourcemap: true });
});

const vsceUrls = {
  baseContentUrl: 'https://github.com/microsoft/vscode-js-debug/blob/main',
  baseImagesUrl: 'https://github.com/microsoft/vscode-js-debug/raw/main',
};

/** Create a VSIX package using the vsce command line tool */
gulp.task('package:createVSIX', () =>
  vsce.createVSIX({
    ...vsceUrls,
    cwd: buildDir,
    useYarn: true,
    packagePath: path.join(buildDir, `${extensionName}.vsix`),
  }),
);

/** Clean, compile, bundle, and create vsix for the extension */
gulp.task(
  'package:prepare',
  gulp.series(
    'clean',
    'compile:static',
    'compile:build-scripts',
    'compile:dynamic',
    'compile:extension',
    'package:bootloader-as-cdp',
    'package:createVSIX',
  ),
);

gulp.task('package', gulp.series('package:prepare', 'package:createVSIX'));

gulp.task(
  'flatSessionBundle',
  gulp.series('clean', 'compile', 'flatSessionBundle:webpack-bundle', 'package:bootloader-as-cdp'),
);

// for now, this task will build both flat session and debug server until we no longer need flat session
gulp.task(
  'vsDebugServerBundle',
  gulp.series(
    'clean',
    'compile',
    'vsDebugServerBundle:webpack-bundle',
    'flatSessionBundle:webpack-bundle',
    'package:bootloader-as-cdp',
  ),
);

/** Publishes the build extension to the marketplace */
gulp.task('publish:vsce', () =>
  vsce.publish({
    ...vsceUrls,
    noVerify: true, // for proposed API usage
    pat: process.env.MARKETPLACE_TOKEN,
    useYarn: true,
    cwd: buildDir,
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

const runPrettier = (onlyStaged, fix, callback) => {
  const child = cp.fork(
    './node_modules/@mixer/parallel-prettier/dist/index.js',
    [fix ? '--write' : '--list-different', 'src/**/*.{ts,tsx}', '!src/**/*.d.ts', '*.md'],
    { stdio: 'inherit' },
  );

  child.on('exit', code => (code ? callback(`Prettier exited with code ${code}`) : callback()));
};

const runEslint = (fix, callback) => {
  const child = cp.fork(
    './node_modules/eslint/bin/eslint.js',
    ['--color', 'src/**/*.ts', fix ? '--fix' : ['--max-warnings=0']],
    { stdio: 'inherit' },
  );

  child.on('exit', code => (code ? callback(`Eslint exited with code ${code}`) : callback()));
};

gulp.task('format:prettier', callback => runPrettier(false, true, callback));
gulp.task('format:eslint', callback => runEslint(true, callback));
gulp.task('format', gulp.series('format:prettier', 'format:eslint'));

gulp.task('lint:prettier', callback => runPrettier(false, false, callback));
gulp.task('lint:eslint', callback => runEslint(false, callback));
gulp.task('lint', gulp.parallel('lint:prettier', 'lint:eslint'));

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
