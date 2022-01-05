type TypedArray =
  | Uint8Array
  | Uint8ClampedArray
  | Uint16Array
  | Uint32Array
  | BigUint64Array
  | Int8Array
  | Int32Array
  | BigInt64Array
  | Float32Array
  | Float64Array;

interface TypedArrayConstructor {
  new(): TypedArray;
  new(values: ArrayBuffer): TypedArray;
}
