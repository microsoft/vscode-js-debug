// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// Improve the default typing of Object.keys(o: T) to be keyof T (without the symbols)
interface ObjectConstructor {
  keys<T>(o: T): WithoutSymbols<keyof T>[];
}
declare var Object: ObjectConstructor;

/** Return the strings that form S and ignore the symbols */
type WithoutSymbols<S> = S extends string ? S : string;
