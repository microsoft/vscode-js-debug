/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { IDiagnosticDump, IDiagnosticSource } from '../adapter/diagnosics';

const nodeInternalMarker = '<node_internals>';
const node16InternalUrl = 'node:';

export const isNodeType = (dump: IDiagnosticDump) =>
  dump.config.type === 'pwa-node'
  || dump.config.type === 'pwa-extensionHost'
  || dump.config.type === 'node-terminal';

export const isBrowserType = (dump: IDiagnosticDump) =>
  dump.config.type === 'pwa-chrome' || dump.config.type === 'pwa-msedge';

export const sortScore = (source: IDiagnosticSource) => {
  if (
    source.absolutePath.startsWith(nodeInternalMarker)
    || source.url.startsWith(node16InternalUrl)
  ) {
    return 2;
  }

  if (source.absolutePath.includes('node_modules')) {
    return 1;
  }

  return 0;
};

export const prettyName = (
  source: { absolutePath: string; url: string },
  dump: IDiagnosticDump,
) => {
  if (source.url.startsWith(node16InternalUrl)) {
    return source.url;
  }

  if (source.absolutePath.startsWith(nodeInternalMarker)) {
    return source.absolutePath;
  }

  if (properAbsolute(source.absolutePath) && dump.config.__workspaceFolder) {
    return properRelative(dump.config.__workspaceFolder, source.absolutePath);
  }

  return source.absolutePath || source.url;
};

export const basename = (source: { prettyName?: string; url: string }) => {
  const parts = (source.prettyName || source.url).split(/\\|\//g);
  return parts[parts.length - 1];
};

// note: that path module webpack uses (path-browserify) doesn't implement win32
// path operations, so implement them by hand...

export const properAbsolute = (testPath: string): boolean =>
  isAbsolutePosix(testPath) || isAbsoluteWin32(testPath);

export const isAbsolutePosix = (path: string) => path.startsWith('/');
export const isAbsoluteWin32 = (path: string) => /^[a-z]:/i.test(path);

export const relative = (fromPath: string, toPath: string) => {
  // shift off the shared prefix of both paths
  const fromParts = fromPath.split('/');
  const toParts = toPath.split('/');
  while (fromParts.length && toParts[0] === fromParts[0]) {
    fromParts.shift();
    toParts.shift();
  }

  // ".." for each remaining level in the fromParts
  const nav = fromParts.length ? new Array(fromParts.length).fill('..') : ['.'];
  return nav.concat(toParts).join('/');
};

export const properRelative = (fromPath: string, toPath: string): string => {
  if (isAbsolutePosix(fromPath)) {
    return relative(fromPath, toPath);
  } else {
    return relative(
      forceForwardSlashes(fixDriveLetter(fromPath)),
      forceForwardSlashes(fixDriveLetter(toPath)),
    );
  }
};

export const forceForwardSlashes = (aUrl: string) => aUrl.replace(/\\\//g, '/').replace(/\\/g, '/');

export const fixDriveLetter = (path: string) => path.slice(0, 1).toUpperCase() + path.slice(1);
