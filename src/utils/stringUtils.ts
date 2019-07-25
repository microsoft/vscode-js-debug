// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

export function trimEnd(text: string, maxLength: number) {
  if (text.length <= maxLength)
    return text;
  return text.substr(0, maxLength - 1) + '…';
}

export function trimMiddle(text: string, maxLength: number) {
  if (text.length <= maxLength)
    return text;
  let leftHalf = maxLength >> 1;
  let rightHalf = maxLength - leftHalf - 1;
  if (text.codePointAt(text.length - rightHalf - 1)! >= 0x10000) {
    --rightHalf;
    ++leftHalf;
  }
  if (leftHalf > 0 && text.codePointAt(leftHalf - 1)! >= 0x10000)
    --leftHalf;
  return text.substr(0, leftHalf) + '\u2026' + text.substr(text.length - rightHalf, rightHalf);
}

export function formatMillisForLog(millis: number): string {
  function pad(n: number, d: number): string {
    let result = String(n);
    return '0'.repeat(d - result.length) + result;
  }
  const d = new Date(millis);
  return `${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}:${pad(d.getSeconds(), 2)}.${pad(d.getMilliseconds(), 3)}`;
}
