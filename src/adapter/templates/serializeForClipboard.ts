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
export const serializeForClipboardTmpl = templateFunction(function(
  valueToStringify: unknown,
  spaces: number,
) {
  const indent = ' '.repeat(spaces);
  const eol = '\n';

  function getTypedArrayContructor(value: unknown): TypedArrayConstructor | undefined {
    if (value instanceof Uint8Array) return Uint8Array;
    if (value instanceof Uint8ClampedArray) return Uint8ClampedArray;
    if (value instanceof Uint16Array) return Uint16Array;
    if (value instanceof Uint32Array) return Uint32Array;
    if (value instanceof BigUint64Array) return BigUint64Array;
    if (value instanceof Int8Array) return Int8Array;
    if (value instanceof Int32Array) return Int32Array;
    if (value instanceof BigInt64Array) return BigInt64Array;
    if (value instanceof Float32Array) return Float32Array;
    if (value instanceof Float64Array) return Float64Array;
  }

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

        if (value instanceof Date) {
          return `"${value.toISOString()}"`;
        }

        if (typeof Node !== 'undefined' && valueToStringify instanceof Node) {
          return valueToStringify.outerHTML;
        }

        const typedCtor = getTypedArrayContructor(value);
        if (typedCtor) {
          return `new ${typedCtor.name}([${(value as TypedArray).join(', ')}])`;
        }

        if (value instanceof ArrayBuffer) {
          return `new Uint8Array([${new Uint8Array(value).join(', ')}]).buffer`;
        }

        if (value instanceof Array) {
          return [
            `[`,
            ...value.map(
              item =>
                indent.repeat(level + 1)
                + serializeToJavaScriptyString(item, level + 1, [...seen, value])
                + ',',
            ),
            indent.repeat(level) + ']',
          ].join(eol);
        }

        const asPropMap = value as { [key: string]: unknown };
        return [
          `{`,
          ...Object.keys(asPropMap).map(
            key =>
              indent.repeat(level + 1)
              + (/^[$a-z_][0-9a-z_$]*$/i.test(key) ? key : JSON.stringify(key))
              + ': '
              + serializeToJavaScriptyString(asPropMap[key], level + 1, [...seen, value])
              + ',',
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
  function(spaces2) {
    const result = ${serializeForClipboardTmpl.expr('this', 'spaces2')};
    return result;
  }
`);
