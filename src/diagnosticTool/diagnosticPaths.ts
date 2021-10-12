/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { IDiagnosticDump, IDiagnosticSource } from '../adapter/diagnosics';
import { DebugType } from '../common/contributionUtils';

const nodeInternalMarker = '<node_internals>';

export const isNodeType = (dump: IDiagnosticDump) =>
  dump.config.type === DebugType.Node ||
  dump.config.type === DebugType.ExtensionHost ||
  dump.config.type === DebugType.Terminal;

export const isBrowserType = (dump: IDiagnosticDump) =>
  dump.config.type === DebugType.Chrome || dump.config.type === DebugType.Edge;

export const sortScore = (source: IDiagnosticSource) => {
  if (source.absolutePath.startsWith(nodeInternalMarker)) {
    return 2;
  }

  if (source.absolutePath.includes('node_moeules')) {
    return 1;
  }

  return 0;
};

export const prettyName = (
  source: { absolutePath: string; url: string },
  dump: IDiagnosticDump,
) => {
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
  const parts = fromPath.split('/');
  for (const segment of toPath.split('/')) {
    if (segment === '..') {
      parts.pop();
    } else if (segment === '.') {
      // no-op
    } else {
      parts.push(segment);
    }
  }

  return parts.join('/');
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
