/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

export interface IPreviewContext {
  /**
   * Max number of characters.
   */
  budget: number;

  /**
   * Whether strings should be quoted.
   */
  quoted: boolean;

  /**
   * Post-processes the object preview.
   */
  postProcess?(result: string): string;
}

/**
 * Known REPL preview types.
 */
export const enum PreviewContextType {
  Repl = 'repl',
  Hover = 'hover',
  PropertyValue = 'propertyValue',
  Copy = 'copy',
  Clipboard = 'clipboard',
}

const repl: IPreviewContext = { budget: 1000, quoted: true };
const hover: IPreviewContext = {
  budget: 1000,
  quoted: true,
  postProcess: str => str.replace(/\n/gm, '\\n').replace(/\r/gm, '\\r').replace(/\t/gm, '\\t'),
};
const copy: IPreviewContext = { budget: Infinity, quoted: false };
const fallback: IPreviewContext = { budget: 100, quoted: true };

export const getContextForType = (type: PreviewContextType | string | undefined) => {
  switch (type) {
    case PreviewContextType.Repl:
      return repl;
    case PreviewContextType.Hover:
      return hover;
    case PreviewContextType.PropertyValue:
      return hover;
    case PreviewContextType.Copy:
    case PreviewContextType.Clipboard:
      return copy;
    default:
      // the type is received straight from the DAP, so it's possible we might
      // get unknown types in the future. Fallback rather than e.g. throwing.
      return fallback;
  }
};
