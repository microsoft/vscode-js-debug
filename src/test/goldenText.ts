// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as fs from 'fs';
import * as path from 'path';
import { expect } from 'chai';
import * as urlUtils from '../common/urlUtils';
import { testFixturesDir } from './test';

const kStabilizeNames = ['id', 'threadId', 'sourceReference', 'variablesReference'];

export class GoldenText {
  _results: String[];
  _testName: String;
  _hasNonAssertedLogs: boolean;
  _workspaceFolder: string;

  constructor(testName, workspaceFolder) {
    this._results = [];
    this._testName = testName;
    this._hasNonAssertedLogs = false;
    this._workspaceFolder = urlUtils.platformPathToPreferredCase(workspaceFolder);
  }

  _getLocation() {
    const stack = (new Error()).stack;
    if (!stack)
      return null;
    const stackFrames = stack.split('\n').slice(1);
    // Find first stackframe that doesn't point to this file.
    for (let frame of stackFrames) {
      frame = frame.trim();
      if (!frame.startsWith('at '))
        return null;
      if (frame.endsWith(')')) {
        const from = frame.indexOf('(');
        frame = frame.substring(from + 1, frame.length - 1);
      } else {
        frame = frame.substring('at '.length);
      }

      const match = frame.match(/^(.*):(\d+):(\d+)$/);
      if (!match)
        return null;
      const filePath = match[1];
      if (filePath === __filename)
        continue;
      return filePath;
    }
    return null;
  }

  hasNonAssertedLogs() {
    return this._hasNonAssertedLogs;
  }

  assertLog(options: { substring?: boolean } = {}) {
    const output = this._results.join('\n') + '\n';
    const testFilePath = this._getLocation();
    if (!testFilePath)
      throw new Error('GoldenText failed to get filename!');
    this._hasNonAssertedLogs = false;
    const fileFriendlyName = this._testName.trim().toLowerCase().replace(/\s/g, '-').replace(/[^-0-9a-zа-яё]/ig, '');
    const actualFilePath = path.join(path.dirname(testFilePath), fileFriendlyName + '.txt');
    const index = actualFilePath.lastIndexOf(path.join('out', 'out', 'test'));
    const goldenFilePath = actualFilePath.substring(0, index) + path.join('src', 'test') + actualFilePath.substring(index + path.join('out', 'out', 'test').length);
    fs.writeFileSync(actualFilePath, output, {encoding: 'utf-8'});
    if (!fs.existsSync(goldenFilePath)) {
      console.log(`----- Missing expectations file, writing a new one`);
      fs.writeFileSync(goldenFilePath, output, {encoding: 'utf-8'});
    } else if (process.env.RESET_RESULTS) {
      fs.writeFileSync(goldenFilePath, output, {encoding: 'utf-8'});
    } else {
      const expectations = fs.readFileSync(goldenFilePath).toString('utf-8');
      if (options.substring) {
        expect(output).to.contain(expectations);
      } else {
        expect(output).to.equal(expectations);
      }
    }
  }

  _sanitize(value: any): string {
    value = String(value);
    if (value.includes(this._workspaceFolder)) {
      value = value
        .replace(this._workspaceFolder, '${workspaceFolder}')
        .replace(/\\/g, '/');
    }

    if (value.includes(testFixturesDir)) {
      value = value
        .replace(testFixturesDir, '${fixturesDir}')
        .replace('/private${fixturesDir}', '${fixturesDir}') // for osx
        .replace(/\\/g, '/');
    }

    return value
        .replace(/VM\d+/g, 'VM<xx>')
        .replace(/\r\n/g, '\n')
        .replace(/@\ .*vscode-pwa(\/|\\)/g, '@ ')
        .replace(/data:text\/html;base64,[a-zA-Z0-9+/]*=?/g, '<data-url>');
  }

  log(item: any, title?: string, stabilizeNames?: string[]): any {
    this._hasNonAssertedLogs = true;
    if (typeof item === 'object')
      return this._logObject(item, title, stabilizeNames);
    this._results.push((title || '') + this._sanitize(item));
    return item;
  }

  _logObject(object: Object, title?: string, stabilizeNames?: string[]): any {
    stabilizeNames = stabilizeNames || kStabilizeNames;
    const lines: string[] = [];

    const dumpValue = (value, prefix, prefixWithName) => {
      if (typeof value === 'object' && value !== null) {
        if (value instanceof Array)
          dumpItems(value, prefix, prefixWithName);
        else
          dumpProperties(value, prefix, prefixWithName);
      } else {
        lines.push(prefixWithName + this._sanitize(value).replace(/\n/g, ' '));
      }
    };

    function dumpProperties(object, prefix, firstLinePrefix) {
      prefix = prefix || '';
      firstLinePrefix = firstLinePrefix || prefix;
      lines.push(firstLinePrefix + '{');

      const propertyNames = Object.keys(object);
      propertyNames.sort();
      for (let i = 0; i < propertyNames.length; ++i) {
        const name = propertyNames[i];
        if (!object.hasOwnProperty(name))
          continue;
        const prefixWithName = '    ' + prefix + name + ' : ';
        let value = object[name];
        if (stabilizeNames && stabilizeNames.includes(name))
          value = `<${typeof value}>`;
        dumpValue(value, '    ' + prefix, prefixWithName);
      }
      lines.push(prefix + '}');
    }

    function dumpItems(object, prefix, firstLinePrefix) {
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

