/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

/**
 * Globs for tools we can auto attach to.
 */
const knownTools: ReadonlySet<string> = new Set([
  //#region test runners
  'node_modules/mocha',
  'node_modules/jest',
  'node_modules/jest-cli',
  'node_modules/ava',
  'node_modules/tape',
  'node_modules/tap',
  //#endregion,

  //#region transpilers
  'node_modules/ts-node',
  'babel-node', // has moved between packages; match anything containing it
  //#endregion,
]);

export const knownToolToken = '$KNOWN_TOOLS$';

export const knownToolGlob = `{${[...knownTools].join(',')}}`;
