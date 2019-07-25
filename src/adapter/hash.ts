// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

const kLen = 8;
const kBits = 8;
const kMask = (1 << kBits) - 1;
type Num = [number, number, number, number, number, number, number, number];

function norm(x: Num): Num {
  for (let i = 0; i < kLen; i++) {
    if (i + 1 < kLen)
      x[i + 1] += (x[i] >>> kBits);
    x[i] = x[i] & kMask;
  }
  return x;
}

function num(x: number): Num {
  return norm([x, 0, 0, 0, 0, 0, 0, 0]);
}

function val(x: Num): number {
  let res = 0;
  for (let i = kLen - 1; i >= 0; i--)
    res = (res << kBits) + x[i];
  return res;
}

function mul(a: Num, b: Num): Num {
  const result: Num = [0, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < kLen; i++) {
    for (let j = 0; i + j < kLen; j++)
      result[i + j] += a[i] * b[j];
  }
  return norm(result);
}

function add(a: Num, b: Num): Num {
  return norm(a.map((_, i) => a[i] + b[i]) as Num);
}

function and(a: Num, b: Num): Num {
  return norm(a.map((_, i) => a[i] & b[i]) as Num);
}

function mod(a: Num, b: number): Num {
  let x = 0;
  for (let i = kLen - 1; i >= 0; i--) {
    x = x * (1 << kBits) + a[i];
    x = x % b;
  }
  return num(x);
}

const kPrimeVal = [0x3FB75161, 0xAB1F4E4F, 0x82675BC5, 0xCD924D35, 0x81ABE279];
const kPrimeMinus1 = kPrimeVal.map(x => num(x - 1));
const kRandom = [num(0x67452301), num(0xEFCDAB89), num(0x98BADCFE), num(0x10325476), num(0xC3D2E1F0)];
const kRandomOdd = [num(0xB4663807), num(0xCC322BF5), num(0xD4F91BBD), num(0xA7BEA11D), num(0x8F462907)];
const kHex = '0123456789abcdef';
const kPower16 = num(1 << 16);
const k0x7FFFFFFF = num(0x7FFFFFFF);

// This is the same hash algorithm used by V8.
export function calculateHash(content: string): string {
  const hashes = [num(0), num(0), num(0), num(0), num(0)];
  const zi = [num(1), num(1), num(1), num(1), num(1)];
  const hashesSize = hashes.length;

  let current = 0;
  for (let i = 0; i < content.length; i += 2) {
    let v: Num;
    if (i + 1 < content.length) {
      v = num(content.charCodeAt(i + 1));
      v = add(mul(v, kPower16), num(content.charCodeAt(i)));
    } else {
      let c = content.charCodeAt(i);
      v = num((c << 8) | (c >>> 8));
    }
    const xi = and(mul(v, kRandomOdd[current]), k0x7FFFFFFF);
    hashes[current] = mod(add(hashes[current], mul(zi[current], xi)), kPrimeVal[current]);
    zi[current] = mod(mul(zi[current], kRandom[current]), kPrimeVal[current]);
    current = current == hashesSize - 1 ? 0 : current + 1;
  }

  for (let i = 0; i < hashesSize; ++i)
    hashes[i] = mod(add(hashes[i], mul(zi[i], kPrimeMinus1[i])), kPrimeVal[i]);

  const result: string[] = [];
  for (let i = 0; i < hashesSize; i++) {
    const v = hashes[i];
    for (let j = 0; 2 * j < kLen; j++) {
      v[kLen - j - 1] = 0;
    }
    let x = val(v);
    let s = '';
    for (let j = 0; j < 8; j++) {
      s = kHex[x & 0xF] + s;
      x = x >>> 4;
    }
    result.push(s);
  }
  return result.join('');
}
