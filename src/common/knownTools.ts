/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

/**
 * Globs for tools we can auto attach to.
 */
const knownTools: ReadonlySet<string> = new Set([
  // #region test runners
  'mocha',
  'jest',
  'jest-cli',
  'ava',
  'tape',
  'tap',
  // #endregion,

  // #region transpilers
  'ts-node',
  'babel-node',
  // #endregion,
]);
export const knownToolToken = '$KNOWN_TOOLS$';

export const knownToolGlob = `{${[...knownTools].join(',')}}`;
