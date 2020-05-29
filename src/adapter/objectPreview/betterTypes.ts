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
  description: string;
};
export type FunctionPreview = { type: 'function'; subtype: undefined; description: string };
export type FunctionObj = TFunction;

export type TNode = {
  type: 'object';
  subtype: 'node';
  description: string;
};
export type NodePreview = TNode & ObjectPreview;
export type NodeObj = TNode & { preview: NodePreview };

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

export type TBigint = {
  type: 'bigint';
  subtype: undefined;
  unserializableValue: string;
  description: string;
};
export type BigintPreview = TBigint;
export type BigintObj = TBigint;

export type AnyObject =
  | ObjectObj
  | NodeObj
  | ArrayObj
  | ErrorObj
  | RegExpObj
  | FunctionObj
  | StringObj
  | BigintObj
  | UndefinedObj
  | NullObj;
export type AnyPreview =
  | ObjectPreview
  | NodePreview
  | ArrayPreview
  | ErrorPreview
  | RegExpPreview
  | FunctionPreview
  | StringPreview
  | BigintPreview
  | UndefinedPreview
  | NullPreview;

export type PreviewAsObjectType = NodePreview | FunctionPreview | ObjectPreview;
export type Numeric = NumberPreview | BigintPreview;
export type Primitive =
  | NullPreview
  | UndefinedPreview
  | StringPreview
  | NumberPreview
  | BigintPreview
  | RegExpPreview
  | ErrorPreview;

export type PropertyPreview = {
  name: string;
  type: AnyPreview['type'];
  value?: string;
} & AnyPreview;
