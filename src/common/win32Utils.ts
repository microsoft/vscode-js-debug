/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import type * as Win32AppContainerTokens from '@vscode/win32-app-container-tokens';
import { once } from './objUtils';

const load = once((): Promise<typeof Win32AppContainerTokens> => {
  if (process.arch === 'arm64') {
    return import(
      // @ts-expect-error no types here
      '@vscode/win32-app-container-tokens/win32-app-container-tokens.win32-arm64-msvc.node'
    );
  } else if (process.arch === 'x64') {
    return import(
      // @ts-expect-error no types here
      '@vscode/win32-app-container-tokens/win32-app-container-tokens.win32-x64-msvc.node'
    );
  } else {
    throw new Error(`Unsupported architecture ${process.arch}`);
  }
});

export function getWinUtils() {
  if (process.platform !== 'win32') {
    throw new Error('Not running on Windows');
  }

  return load();
}
