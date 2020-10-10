/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

declare module 'acorn-walk' {
  import { Node } from 'estree';

  export type Visitors<Args extends unknown[] = []> = {
    [T in Node['type']]?: (node: Node & { type: T }, ...args: Args) => void;
  };

  export type BaseVisitor<State> = Required<Visitors<[State, (node: Node, state: State) => void]>>;

  /**
   * Type for an acorn/estree node. estree provides better typing for
   * generators, but its definitions are slightly incompatible with acorn's
   * (acorn generates a valid estree, it's just the typings which mismatch.)
   */
  interface EstreeNode {
    type: string;
  }

  export function simple<State = void>(
    node: EstreeNode,
    visitors: Visitors,
    base?: BaseVisitor<State>,
    state?: State,
  ): void;

  export function ancestor<State = void>(
    node: EstreeNode,
    visitors: Visitors<[Node[]]>,
    base?: BaseVisitor<State>,
    state?: State,
  ): void;

  export function recursive<State = void>(
    node: EstreeNode,
    state: State,
    visitors: Visitors<[Node[], State, (node: Node, state: State) => void]>,
    base?: BaseVisitor<State>,
  ): void;

  export function full<State = void>(
    node: EstreeNode,
    callback: (node: Node, state: State, type: Node['type']) => void,
    base?: BaseVisitor<State>,
    state?: State,
  ): void;

  export function fullAncestor<State = void>(
    node: EstreeNode,
    callback: (node: Node, state: State, ancestors: Node[], type: Node['type']) => void,
    base?: BaseVisitor<State>,
    state?: State,
  ): void;
}
