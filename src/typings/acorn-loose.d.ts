/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

declare module 'acorn-loose' {
  import acorn from 'acorn';
  import { Node } from 'estree';

  export function isDummy(node: acorn.Node | Node): boolean;

  export = acorn;
}
