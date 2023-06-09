/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import Cdp from '../../cdp/api';

/**
 * A collection of more strongly defined types. Derived from experimenting
 * in Chrome devtools.
 */

export type TArray = {
  type: 'object';
  subtype: 'array' | 'typedarray';
  description: string;
};
export type ArrayPreview = TArray & {
  properties: (AnyPreview & Cdp.Runtime.PropertyPreview)[];
  overflow: boolean;
};
export type ArrayObj = Cdp.Runtime.RemoteObject & TArray & { preview: ArrayPreview };

export type TFunction = {
  type: 'function';
  subtype: undefined;
  className: string;
  // defined in V8, undefined in Hermes
  description?: string;
};
export type FunctionPreview = {
  type: 'function';
  subtype: undefined;
  description: string;
  entries?: undefined;
  properties?: undefined;
  overflow?: undefined;
};
export type FunctionObj = TFunction;

export type TNode = {
  type: 'object';
  subtype: 'node';
  description: string;
};
export type NodePreview = TNode & ObjectPreview;
export type NodeObj = TNode & { preview: NodePreview };

export type TSet = {
  type: 'object';
  subtype: 'set';
  className: string;
  description: string;
};
export type SetPreview = TSet & {
  entries: { key?: undefined; value: AnyPreview }[];
  properties: PropertyPreview[];
  overflow: boolean;
};
export type SetObj = TSet & { preview: SetPreview };

export type TMap = {
  type: 'object';
  subtype: 'map';
  className: string;
  description: string;
};
export type MapPreview = TMap & {
  entries: { key: AnyPreview; value: AnyPreview }[];
  properties: PropertyPreview[];
  overflow: boolean;
};
export type MapObj = TMap & { preview: MapPreview };

export type TString = {
  type: 'string';
  value: string;
  subtype: undefined;
  description?: string;
};
export type StringPreview = TString;
export type StringObj = TString;

export type TObject = {
  type: 'object';
  subtype: undefined;
  className: string;
  description: string;
};
export type ObjectPreview = TObject & {
  properties?: PropertyPreview[];
  overflow: boolean;
  entries?: { key: AnyPreview; value: AnyPreview }[];
};
export type ObjectObj = TObject & { preview: ObjectPreview };

export type TRegExp = {
  type: 'object';
  subtype: 'regexp';
  className: 'RegExp';
  description: string;
};
export type RegExpPreview = TRegExp & { overflow: boolean; properties: PropertyPreview[] };
export type RegExpObj = TRegExp & { preview: RegExpPreview };

export type TError = {
  type: 'object';
  subtype: 'error';
  className: string;
  description: string;
};
export type ErrorPreview = TError & { overflow: boolean };
export type ErrorObj = TError & { preview: ErrorPreview };

export type TNull = { type: 'object'; subtype: 'null' };
export type NullPreview = TNull;
export type NullObj = TNull;

export type TUndefined = { type: 'undefined'; subtype: undefined };
export type UndefinedPreview = TUndefined;
export type UndefinedObj = TUndefined;

export type TNumber = { type: 'number'; subtype: undefined; value: number; description: string };
export type NumberPreview = TNumber;
export type NumberObj = TNumber;

export type TSpecialNumber = {
  type: 'number';
  unserializableValue: 'NaN' | 'Infinity' | '-Infinity';
  description: string;
};
export type SpecialNumberPreview = TSpecialNumber;

export type TBigint = {
  type: 'bigint';
  subtype: undefined;
  unserializableValue?: string;
  description: string;
};
export type BigintPreview = TBigint;
export type BigintObj = TBigint;

export type AnyObject =
  | ObjectObj
  | NodeObj
  | ArrayObj
  | SetObj
  | MapObj
  | ErrorObj
  | RegExpObj
  | FunctionObj
  | StringObj
  | NumberObj
  | BigintObj
  | UndefinedObj
  | NullObj;
export type AnyPreview =
  | ObjectPreview
  | SetPreview
  | MapPreview
  | NodePreview
  | ArrayPreview
  | ErrorPreview
  | RegExpPreview
  | FunctionPreview
  | StringPreview
  | BigintPreview
  | UndefinedPreview
  | NullPreview;

export type PreviewAsObjectType =
  | NodePreview
  | FunctionPreview
  | ObjectPreview
  | MapPreview
  | SetPreview;
export type Numeric = NumberPreview | BigintPreview | TSpecialNumber;
export type Primitive =
  | NullPreview
  | UndefinedPreview
  | StringPreview
  | NumberPreview
  | SpecialNumberPreview
  | BigintPreview
  | RegExpPreview
  | ErrorPreview;

export type PropertyPreview = {
  name: string;
  type: AnyPreview['type'];
  value?: string;
} & AnyPreview;
