/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { IPosition } from './positions';

export function trimEnd(text: string, maxLength: number) {
  if (text.length <= maxLength) return text;
  return text.substr(0, maxLength - 1) + '…';
}

export function trimMiddle(text: string, maxLength: number) {
  if (text.length <= maxLength) return text;
  let leftHalf = maxLength >> 1;
  let rightHalf = maxLength - leftHalf - 1;

  const rightPoint = text.codePointAt(text.length - rightHalf - 1);
  if (rightPoint && rightPoint >= 0x10000) {
    --rightHalf;
    ++leftHalf;
  }

  const leftPoint = text.codePointAt(leftHalf - 1);
  if (leftHalf > 0 && leftPoint && leftPoint >= 0x10000) --leftHalf;
  return text.substr(0, leftHalf) + '\u2026' + text.substr(text.length - rightHalf, rightHalf);
}

export function formatMillisForLog(millis: number): string {
  function pad(n: number, d: number): string {
    const result = String(n);
    return '0'.repeat(d - result.length) + result;
  }
  const d = new Date(millis);
  return `${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}:${pad(d.getSeconds(), 2)}.${
    pad(
      d.getMilliseconds(),
      3,
    )
  }`;
}

const regexChars = '/\\.?*()^${}|[]+';

export const isRegexSpecialChar = (chr: string) => regexChars.includes(chr);

export function escapeRegexSpecialChars(str: string, except?: string): string {
  const useRegexChars = regexChars
    .split('')
    .filter(c => !except || except.indexOf(c) < 0)
    .join('')
    .replace(/[\\\]]/g, '\\$&');

  const r = new RegExp(`[${useRegexChars}]`, 'g');
  return str.replace(r, '\\$&');
}

export class PositionToOffset {
  private readonly lines: number[] = [];

  constructor(public readonly source: string) {
    this.lines.push(0);
    for (let i = source.indexOf('\n'); i !== -1; i = source.indexOf('\n', i + 1)) {
      this.lines.push(i + 1);
    }
  }

  /**
   * Gets the base-0 line number.
   */
  public getLineOffset(n: number) {
    return n >= this.lines.length ? this.source.length : this.lines[n];
  }

  /**
   * Converts from a base 0 line and column to a file offset.
   */
  public convert(position: IPosition) {
    const base0 = position.base0;
    if (base0.lineNumber > this.lines.length) {
      return this.source.length;
    }

    const thisLine = this.lines[base0.lineNumber];
    const nextLine = this.lines[base0.lineNumber + 1] ?? this.source.length + 1;

    return thisLine + Math.min(nextLine - thisLine - 1, base0.columnNumber);
  }
}
