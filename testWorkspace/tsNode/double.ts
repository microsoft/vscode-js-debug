/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
console.assert(true); // some statement since you cannot set a breakpoint at a fn declaration

export function triple(n: number) {
  return n * 3;
}

export interface ISomeStuffToMakeLinesNotMatch {
  some: true;
  properties: false;
  here: string;
}

export function double(n: number) {
  return n * 2; // this line is a different # in the compiled source
}
