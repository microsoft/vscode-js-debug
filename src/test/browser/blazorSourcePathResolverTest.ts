/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import { promises as fsPromises } from 'fs';
import path from 'path';
import { LocalFsUtils } from '../../common/fsUtils';
import { Logger } from '../../common/logging/logger';
import { getCaseSensitivePaths } from '../../common/urlUtils';
import { defaultSourceMapPathOverrides } from '../../configuration';
import { BlazorSourcePathResolver } from '../../targets/browser/blazorSourcePathResolver';
import { testVueMapper } from '../../targets/browser/browserPathResolver.test';
import { testFixturesDir } from '../test';

function createBlazorSourcePathResolver(
  remoteFilePrefix: string | undefined,
): BlazorSourcePathResolver {
  return new BlazorSourcePathResolver(
    testVueMapper,
    new LocalFsUtils(fsPromises),
    {
      workspaceFolder: testFixturesDir,
      pathMapping: { '/': path.join(testFixturesDir, 'web') },
      clientID: 'vscode',
      baseUrl: 'http://localhost:1234/',
      sourceMapOverrides: defaultSourceMapPathOverrides(path.join(testFixturesDir, 'web')),
      localRoot: null,
      remoteRoot: null,
      resolveSourceMapLocations: null,
      remoteFilePrefix,
    },
    Logger.null,
  );
}

const isWindows = process.platform === 'win32';
const platformRoot = isWindows ? 'C:' : '/c';

describe('BlazorSourcePathResolver.absolutePathToUrlRegexp', () => {
  it('generates the correct regexp in local scenarios', async () => {
    const sourcePath = path.join(
      platformRoot,
      'Users',
      'digeff',
      'source',
      'repos',
      'MyBlazorApp',
      'MyBlazorApp',
      'Pages',
      'Counter.razor',
    );
    const regexp = await createBlazorSourcePathResolver(undefined).absolutePathToUrlRegexp(
      sourcePath,
    );

    if (getCaseSensitivePaths()) {
      expect(regexp).to.equal(
        'file:\\/\\/\\/c\\/Users\\/digeff\\/source\\/repos\\/MyBlazorApp\\/MyBlazorApp\\/Pages\\/Counter\\.razor($|\\?)'
          + '|\\/c\\/Users\\/digeff\\/source\\/repos\\/MyBlazorApp\\/MyBlazorApp\\/Pages\\/Counter\\.razor($|\\?)'
          + '|http:\\/\\/localhost:1234\\/\\.\\.\\/\\.\\.\\/\\.\\.\\/\\.\\.\\/\\.\\.\\/\\.\\.\\/\\.\\.\\/c\\/Users\\/digeff\\/source\\/repos\\/MyBlazorApp\\/MyBlazorApp\\/Pages\\/Counter\\.razor($|\\?)',
      );
    } else {
      // This regexp was generated from running the real scenario, verifying that the breakpoint with this regexp works, and then copying it here
      expect(regexp).to.contain(
        '[fF][iI][lL][eE]:\\/\\/\\/[cC]:\\/[uU][sS][eE][rR][sS]\\/[dD][iI][gG][eE][fF][fF]\\/[sS][oO][uU][rR][cC][eE]\\/'
          + '[rR][eE][pP][oO][sS]\\/[mM][yY][bB][lL][aA][zZ][oO][rR][aA][pP][pP]\\/[mM][yY][bB][lL][aA][zZ][oO][rR][aA][pP][pP]\\/'
          + '[pP][aA][gG][eE][sS]\\/[cC][oO][uU][nN][tT][eE][rR]\\.[rR][aA][zZ][oO][rR]($|\\?)|[cC]:\\\\[uU][sS][eE][rR][sS]\\\\[dD][iI][gG][eE][fF][fF]\\\\'
          + '[sS][oO][uU][rR][cC][eE]\\\\[rR][eE][pP][oO][sS]\\\\[mM][yY][bB][lL][aA][zZ][oO][rR][aA][pP][pP]\\\\[mM][yY][bB][lL][aA][zZ][oO][rR][aA][pP][pP]\\\\'
          + '[pP][aA][gG][eE][sS]\\\\[cC][oO][uU][nN][tT][eE][rR]\\.[rR][aA][zZ][oO][rR]($|\\?)',
      );
    }
  });

  if (isWindows) {
    // At the moment the Blazor remote scenario is only supported on VS/Windows

    it('generates the correct regexp in codespace scenarios', async () => {
      const remoteFilePrefix = path.join(
        platformRoot,
        'Users',
        'digeff',
        'AppData',
        'Local',
        'Temp',
        '2689D069D40B1EFF4B570B2DB12506073980',
        '5~~',
      );
      const sourcePath =
        `${remoteFilePrefix}\\C$\\workspace\\NewBlazorWASM\\NewBlazorWASM\\Pages\\Counter.razor`;
      const regexp = await createBlazorSourcePathResolver(remoteFilePrefix)
        .absolutePathToUrlRegexp(
          sourcePath,
        );

      // This regexp was generated from running the real scenario, verifying that the breakpoint with this regexp works, and then copying it here
      expect(regexp).to.equal(
        'dotnet://.*\\.dll/[cC]\\/[wW][oO][rR][kK][sS][pP][aA][cC][eE]\\/[nN][eE][wW][bB][lL][aA][zZ][oO][rR][wW][aA][sS][mM]\\/'
          + '[nN][eE][wW][bB][lL][aA][zZ][oO][rR][wW][aA][sS][mM]\\/[pP][aA][gG][eE][sS]\\/[cC][oO][uU][nN][tT][eE][rR]\\.[rR][aA][zZ][oO][rR]($|\\?)',
      );
    });
  }
});
