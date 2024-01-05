/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

declare module 'astring' {
  import { Node } from 'estree';
  import { Writable } from 'stream';

  /**
   * State shape passed to generator code.
   */
  export interface State {
    output: string;
    write(code: string): void;
    writeComments: boolean;
    indent: string;
    lineEnd: string;
    indentLevel: number;
  }

  /**
   * State shape if a sourceMap is specified.
   */
  export interface StateWithSourceMap {
    line: number;
    column: number;
    lineEndSize: number;
    mapping: Mapping;
  }

  /**
   * Options for generating code in astring.
   */
  export interface Options {
    /**
     * If present, source mappings will be written to the generator.
     */
    sourceMap?: {
      file?: string;
      addMapping(mapping: {
        original: { line: number; column: number };
        generated: { line: number; column: number };
        source: string | undefined;
      });
    };
    /**
     * String to use for indentation, defaults to "  ".
     */
    indent?: string;
    /**
     * String to use for line endings, defaults to "\n"
     */
    lineEnd?: string;
    /**
     * Indent level to start from, defaults to "0"
     */
    startingIndentLevel?: number;
    /**
     * Generate comments, defaults to false.
     */
    comments?: boolean;
    /**
     * Output stream to write the render code to, defaults to null.
     */
    output?: Writable | null;
    /**
     * Custom code generator logic.
     */
    generator?: { [T in Node['type']]: (node: Node & { type: T }, state: State) => void };
  }

  /**
   * Type for an acorn/estree node. estree provides better typing for
   * generators, but its definitions are slightly incompatible with acorn's
   * (acorn generates a valid estree, it's just the typings which mismatch.)
   */
  interface EstreeNode {
    type: string;
  }

  export function generate(node: EstreeNode, options?: Options): string;
}
