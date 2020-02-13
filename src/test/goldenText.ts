/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { expect } from 'chai';
import * as urlUtils from '../common/urlUtils';
import { testFixturesDir } from './test';
import { escapeRegexSpecialChars } from '../common/stringUtils';
import { forceForwardSlashes } from '../common/pathUtils';

const kStabilizeNames = ['id', 'threadId', 'sourceReference', 'variablesReference'];

const trimLineWhitespace = (str: string) =>
  str
    .split('\n')
    .map(l => l.trimRight())
    .join('\n')
    .replace(/\\r\\n/g, '\\n');

export class GoldenText {
  _results: string[];
  _testName: string;
  _hasNonAssertedLogs: boolean;
  _workspaceFolder: string;

  constructor(testName: string, workspaceFolder: string) {
    this._results = [];
    this._testName = testName;
    this._hasNonAssertedLogs = false;
    this._workspaceFolder = urlUtils.platformPathToPreferredCase(workspaceFolder);
  }

  _getLocation() {
    const stack = new Error().stack;
    if (!stack) return null;
    const stackFrames = stack.split('\n').slice(1);
    // Find first stackframe that doesn't point to this file.
    for (let frame of stackFrames) {
      frame = frame.trim();
      if (!frame.startsWith('at ')) return null;
      if (frame.endsWith(')')) {
        const from = frame.indexOf('(');
        frame = frame.substring(from + 1, frame.length - 1);
      } else {
        frame = frame.substring('at '.length);
      }

      const match = frame.match(/^(.*):(\d+):(\d+)$/);
      if (!match) return null;
      const filePath = match[1];
      if (filePath === __filename) continue;
      return filePath;
    }
    return null;
  }

  hasNonAssertedLogs() {
    return this._hasNonAssertedLogs;
  }

  getOutput(): string {
    return trimLineWhitespace(this._results.join('\n') + '\n');
  }

  /**
   * This method _must_ be called from the test file.
   * The output file will go next to the file from which this is called.
   */
  assertLog(options: { substring?: boolean; customAssert?: (expected: string) => any } = {}) {
    const output = this.getOutput();
    this._hasNonAssertedLogs = false;

    if (options.customAssert) {
      options.customAssert(output);
      return;
    }

    const goldenFilePath = this.findGoldenFilePath();
    if (!fs.existsSync(goldenFilePath)) {
      console.log(`----- Missing expectations file, writing a new one`);
      fs.writeFileSync(goldenFilePath, output, { encoding: 'utf-8' });
    } else if (process.env.RESET_RESULTS) {
      fs.writeFileSync(goldenFilePath, output, { encoding: 'utf-8' });
    } else {
      const expectations = trimLineWhitespace(fs.readFileSync(goldenFilePath).toString('utf-8'));

      try {
        if (options.substring) {
          expect(output).to.contain(expectations);
        } else {
          expect(output).to.equal(expectations);
        }
      } catch (err) {
        fs.writeFileSync(goldenFilePath + '.actual', output, { encoding: 'utf-8' });
        throw err;
      }
    }
  }

  private findGoldenFilePath() {
    const testFilePath = this._getLocation();
    if (!testFilePath) {
      throw new Error('GoldenText failed to get filename!');
    }

    const fileFriendlyTestName = this._testName
      .trim()
      .toLowerCase()
      .replace(/\s/g, '-')
      .replace(/[^-0-9a-zа-яё]/gi, '');

    const testFileBase = path.resolve(
      __dirname,
      '..',
      '..',
      '..',
      'src',
      'test',
      path.relative(__dirname, path.dirname(testFilePath)),
      fileFriendlyTestName,
    );

    const platformPath = testFileBase + `.${process.platform}.txt`;
    if (fs.existsSync(platformPath)) {
      return platformPath;
    }

    return testFileBase + '.txt';
  }

  _sanitize(value: string): string {
    // replaces path like C:/testDir/foo/bar.js -> ${testDir}/foo/bar.js
    const replacePath = (needle: string, replacement: string) => {
      // Escape special chars, force paths to use forward slashes
      const safeStr = escapeRegexSpecialChars(forceForwardSlashes(needle), '/');
      // Create an re that allows for any slash delimiter, and looks at the rest of the line
      const re = new RegExp(safeStr.replace(/\//g, '[\\\\/]') + '(.*)', 'gi');

      // Replace it with the ${replacementString} and a forward-slashed version
      // of the rest of the line.
      value = value.replace(re, (_match, trailing) => replacement + forceForwardSlashes(trailing));
    };

    value = String(value);
    replacePath(this._workspaceFolder, '${workspaceFolder}');
    replacePath(testFixturesDir, '${fixturesDir}');
    value = value.replace(/testWorkspace/g, '${workspaceFolder}');
    value = value.replace('/private${fixturesDir}', '${fixturesDir}'); // for osx

    // Don't compare blackboxed code, as this is subject to change between
    // runtime/Node.js versions.
    value = value
      .split('\n')
      .filter(line => !line.includes('hidden: blackboxed'))
      .join('\n');

    return value
      .replace(/VM\d+/g, 'VM<xx>')
      .replace(/\r\n/g, '\n')
      .replace(/@\ .*vscode-pwa(\/|\\)/g, '@ ')
      .replace(/data:text\/html;base64,[a-zA-Z0-9+/]*=?/g, '<data-url>');
  }

  log(item: any, title?: string, stabilizeNames?: string[]): any {
    this._hasNonAssertedLogs = true;
    if (typeof item === 'object') return this._logObject(item, title, stabilizeNames);
    this._results.push((title || '') + this._sanitize(item));
    return item;
  }

  _logObject(object: Record<string, any>, title?: string, stabilizeNames?: string[]): any {
    stabilizeNames = stabilizeNames || kStabilizeNames;
    const lines: string[] = [];

    const dumpValue = (value: any, prefix: string, prefixWithName: string) => {
      if (typeof value === 'object' && value !== null) {
        if (value instanceof Array) dumpItems(value, prefix, prefixWithName);
        else dumpProperties(value, prefix, prefixWithName);
      } else {
        lines.push(prefixWithName + this._sanitize(value).replace(/\n/g, ' '));
      }
    };

    function dumpProperties(object: any, prefix: string, firstLinePrefix: string) {
      prefix = prefix || '';
      firstLinePrefix = firstLinePrefix || prefix;
      lines.push(firstLinePrefix + '{');

      const propertyNames = Object.keys(object);
      propertyNames.sort();
      for (let i = 0; i < propertyNames.length; ++i) {
        const name = propertyNames[i];
        if (!object.hasOwnProperty(name)) continue;
        const prefixWithName = '    ' + prefix + name + ' : ';
        let value = object[name];
        if (stabilizeNames && stabilizeNames.includes(name)) value = `<${typeof value}>`;
        dumpValue(value, '    ' + prefix, prefixWithName);
      }
      lines.push(prefix + '}');
    }

    function dumpItems(object: any, prefix: string, firstLinePrefix: string) {
      prefix = prefix || '';
      firstLinePrefix = firstLinePrefix || prefix;
      lines.push(firstLinePrefix + '[');
      for (let i = 0; i < object.length; ++i)
        dumpValue(object[i], '    ' + prefix, '    ' + prefix + '[' + i + '] : ');
      lines.push(prefix + ']');
    }

    dumpValue(object, '', title || '');
    this._results.push(...lines);
    return object;
  }
}
