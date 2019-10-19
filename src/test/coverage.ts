import * as fs from 'fs';
import * as glob from 'glob';
import * as paths from 'path';

const istanbul = require('istanbuljs');
const remapIstanbul = require('remap-istanbul');

interface ITestRunnerOptions {
  enabled?: boolean;
  coverageDir: string;
  sourcePath: string;
  ignorePatterns: string[];
  includePid?: boolean;
  reports?: string[];
  verbose?: boolean;
}

/**
 * Coverage runner, via https://github.com/codecov/example-typescript-vscode-extension
 *
 * @license
 * The MIT License (MIT)
 *
 * Copyright (c) 2017 Nikita Gryzlov <nixel2007@gmail.com>
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
export class CoverageRunner {
  private coverageVar: string = '$$cov_' + new Date().getTime() + '$$';
  private transformer: any = undefined;
  private matchFn: any = undefined;
  private instrumenter: any = undefined;

  constructor(private options: ITestRunnerOptions) {}

  public setupCoverage(): void {
    // Set up Code Coverage, hooking require so that instrumented code is returned
    let self = this;
    self.instrumenter = new istanbul.Instrumenter({ coverageVariable: self.coverageVar });
    let sourceRoot = self.options.sourcePath;

    // Glob source files
    let srcFiles = glob.sync('**/**.js', {
      cwd: sourceRoot,
      ignore: self.options.ignorePatterns,
    });

    // Create a match function - taken from the run-with-cover.js in istanbul.
    let decache = require('decache');
    let fileMap = {};
    srcFiles.forEach(file => {
      let fullPath = paths.join(sourceRoot, file);
      fileMap[fullPath] = true;

      // On Windows, extension is loaded pre-test hooks and this mean we lose
      // our chance to hook the Require call. In order to instrument the code
      // we have to decache the JS file so on next load it gets instrumented.
      // This doesn"t impact tests, but is a concern if we had some integration
      // tests that relied on VSCode accessing our module since there could be
      // some shared global state that we lose.
      decache(fullPath);
    });

    self.matchFn = (file): boolean => {
      return fileMap[file];
    };
    self.matchFn.files = Object.keys(fileMap);

    // Hook up to the Require function so that when this is called, if any of our source files
    // are required, the instrumented version is pulled in instead. These instrumented versions
    // write to a global coverage variable with hit counts whenever they are accessed
    self.transformer = self.instrumenter.instrumentSync.bind(self.instrumenter);
    let hookOpts = { verbose: false, extensions: ['.js'] };
    istanbul.hook.hookRequire(self.matchFn, self.transformer, hookOpts);

    // initialize the global variable to stop mocha from complaining about leaks
    global[self.coverageVar] = {};
  }

  /**
   * Writes a coverage report. Note that as this is called in the process exit callback, all calls must be synchronous.
   *
   * @returns {void}
   *
   * @memberOf CoverageRunner
   */
  public reportCoverage(): void {
    let self = this;
    istanbul.hook.unhookRequire();
    let cov: any;
    if (
      typeof global[self.coverageVar] === 'undefined' ||
      Object.keys(global[self.coverageVar]).length === 0
    ) {
      console.error(
        'No coverage information was collected, exit without writing coverage information',
      );
      return;
    } else {
      cov = global[self.coverageVar];
    }

    // TODO consider putting this under a conditional flag
    // Files that are not touched by code ran by the test runner is manually instrumented, to
    // illustrate the missing coverage.
    self.matchFn.files.forEach(file => {
      if (!cov[file]) {
        self.transformer(fs.readFileSync(file, 'utf-8'), file);

        // When instrumenting the code, istanbul will give each FunctionDeclaration a value of 1 in coverState.s,
        // presumably to compensate for function hoisting. We need to reset this, as the function was not hoisted,
        // as it was never loaded.
        Object.keys(self.instrumenter.coverState.s).forEach(key => {
          self.instrumenter.coverState.s[key] = 0;
        });

        cov[file] = self.instrumenter.coverState;
      }
    });

    // TODO Allow config of reporting directory with
    let reportingDir = self.options.coverageDir;
    let includePid = self.options.includePid;
    let pidExt = includePid ? '-' + process.pid : '';
    let coverageFile = paths.resolve(reportingDir, 'coverage' + pidExt + '.json');

    if (!fs.existsSync(reportingDir)) {
      fs.mkdirSync(reportingDir);
    }

    fs.writeFileSync(coverageFile, JSON.stringify(cov), 'utf8');

    let remappedCollector = remapIstanbul.remap(cov, {
      warn: warning => {
        // We expect some warnings as any JS file without a typescript mapping will cause this.
        // By default, we"ll skip printing these to the console as it clutters it up
        if (self.options.verbose) {
          console.warn(warning);
        }
      },
    });

    let reporter = new istanbul.Reporter(undefined, reportingDir);
    let reportTypes = self.options.reports instanceof Array ? self.options.reports : ['lcov'];
    reporter.addAll(reportTypes);
    reporter.write(remappedCollector, true, () => {
      console.log(`reports written to ${reportingDir}`);
    });
  }
}
