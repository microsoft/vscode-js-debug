/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { remoteFunction, templateFunction } from '.';

declare class Node {
  readonly outerHTML: string;
}

/**
 * Safe-stringifies the value as JSON, replacing
 */
export const serializeForClipboardTmpl = templateFunction(function (
  valueToStringify: unknown,
  spaces: number,
) {
  const indent = ' '.repeat(spaces);
  const eol = '\n';
  function serializeToJavaScriptyString(value: unknown, level = 0, seen: unknown[] = []): string {
    switch (typeof value) {
      case 'bigint':
        return `${value}n`;
      case 'boolean':
        return value.toString();
      case 'function': {
        const lines = value
          .toString()
          .replace(/^[^\s]+\(/, 'function(')
          .split(/\r?\n/g);
        let trimSpaceRe = /^$/;
        for (const line of lines) {
          const match = /^[ \t]+/.exec(line);
          if (match) {
            trimSpaceRe = new RegExp(`^[ \\t]{0,${match[0].length}}`);
            break;
          }
        }

        return lines
          .map((line, i) => {
            if (i === 0) {
              return line;
            }

            line = line.replace(trimSpaceRe, '');

            if (i === lines.length - 1) {
              return indent.repeat(level) + line;
            }

            return indent.repeat(level + 1) + line;
          })
          .join(eol);
      }
      case 'number':
        return `${value}`;
      case 'object':
        if (value === null) {
          return 'null';
        }

        if (seen.includes(value)) {
          return '[Circular]';
        }

        if (typeof Node !== 'undefined' && valueToStringify instanceof Node) {
          return valueToStringify.outerHTML;
        }

        if (value instanceof Array) {
          return [
            `[`,
            ...value.map(
              item =>
                indent.repeat(level + 1) +
                serializeToJavaScriptyString(item, level + 1, [...seen, value]) +
                ',',
            ),
            indent.repeat(level) + ']',
          ].join(eol);
        }

        const asPropMap = value as { [key: string]: unknown };
        return [
          `{`,
          ...Object.keys(asPropMap).map(
            key =>
              indent.repeat(level + 1) +
              (/^[$a-z_][0-9a-z_$]*$/i.test(key) ? key : JSON.stringify(key)) +
              ': ' +
              serializeToJavaScriptyString(asPropMap[key], level + 1, [...seen, value]) +
              ',',
          ),
          indent.repeat(level) + '}',
        ].join(eol);
      case 'string':
        return JSON.stringify(value);
      case 'symbol':
        return value.toString();
      case 'undefined':
        return 'undefined';
      default:
        return String(value);
    }
  }

  try {
    return serializeToJavaScriptyString(valueToStringify);
  } catch {
    return '' + valueToStringify;
  }
});

export const serializeForClipboard = remoteFunction<[number], string>(`
  function(spaces) {
    const result = ${serializeForClipboardTmpl('this', 'spaces')};
    return result;
  }
`);
