/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { Base1Position } from './positions';

// Either match lines like
// "    at fulfilled (/Users/roblou/code/testapp-node2/out/app.js:5:58)"
// or
// "    at /Users/roblou/code/testapp-node2/out/app.js:60:23"
// and replace the path in them
const re1 = /^(\W*at .*\()(.*):(\d+):(\d+)(\))$/;
const re2 = /^(\W*at )(.*):(\d+):(\d+)$/;

/**
 * Parses a textual stack trace.
 */
export class StackTraceParser {
  /** Gets whether the stacktrace has any locations in it. */
  public static isStackLike(str: string) {
    return re1.test(str) || re2.test(str);
  }
  constructor(private readonly stack: string) {}

  /** Iterates over segments of text and locations in the stack. */
  *[Symbol.iterator]() {
    for (const line of this.stack.split('\n')) {
      const match = re1.exec(line) || re2.exec(line);
      if (!match) {
        yield line + '\n';
        continue;
      }

      const [, prefix, url, lineNo, columnNo, suffix] = match;
      if (prefix) {
        yield prefix;
      }

      yield new StackTraceLocation(url, new Base1Position(Number(lineNo), Number(columnNo)));

      if (suffix) {
        yield suffix;
      }

      yield '\n';
    }
  }
}

export class StackTraceLocation {
  constructor(public readonly path: string, public readonly position: Base1Position) {}

  public toString() {
    return `${this.path}:${this.position.lineNumber}:${this.position.columnNumber}`;
  }
}
