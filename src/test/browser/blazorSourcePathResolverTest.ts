/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import { promises as fsPromises } from 'fs';
import path from 'path';
import { LocalFsUtils } from '../../common/fsUtils';
import { Logger } from '../../common/logging/logger';
import { defaultSourceMapPathOverrides } from '../../configuration';
import { BlazorSourcePathResolver } from '../../targets/browser/blazorSourcePathResolver';
import { testFixturesDir } from '../test';
import { testVueMapper } from './browserPathResolverTest';

function createBlazorSourcePathResolver(
  remoteFilePrefix: string | undefined,
): BlazorSourcePathResolver {
  return new BlazorSourcePathResolver(
    testVueMapper,
    new LocalFsUtils(fsPromises),
    {
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

describe('BlazorSourcePathResolver.absolutePathToUrlRegexp', () => {
  it('generates the correct regexp in local scenarios', () => {
    const sourcePath =
      'c:\\Users\\digeff\\source\\repos\\MyBlazorApp\\MyBlazorApp\\Pages\\Counter.razor';
    const regexp = createBlazorSourcePathResolver(undefined).absolutePathToUrlRegexp(sourcePath);

    // This regexp was generated from running the real scenario, verifying that the breakpoint with this regexp works, and then copying it here
    expect(regexp).to.equal(
      '[fF][iI][lL][eE]:\\/\\/\\/[cC]:\\/[uU][sS][eE][rR][sS]\\/[dD][iI][gG][eE][fF][fF]\\/[sS][oO][uU][rR][cC][eE]\\/' +
        '[rR][eE][pP][oO][sS]\\/[mM][yY][bB][lL][aA][zZ][oO][rR][aA][pP][pP]\\/[mM][yY][bB][lL][aA][zZ][oO][rR][aA][pP][pP]\\/' +
        '[pP][aA][gG][eE][sS]\\/[cC][oO][uU][nN][tT][eE][rR]\\.[rR][aA][zZ][oO][rR]|[cC]:\\\\[uU][sS][eE][rR][sS]\\\\[dD][iI][gG][eE][fF][fF]\\\\' +
        '[sS][oO][uU][rR][cC][eE]\\\\[rR][eE][pP][oO][sS]\\\\[mM][yY][bB][lL][aA][zZ][oO][rR][aA][pP][pP]\\\\[mM][yY][bB][lL][aA][zZ][oO][rR][aA][pP][pP]\\\\' +
        '[pP][aA][gG][eE][sS]\\\\[cC][oO][uU][nN][tT][eE][rR]\\.[rR][aA][zZ][oO][rR]',
    );
  });

  it('generates the correct regexp in codespace scenarios', () => {
    const remoteFilePrefix =
      'c:\\Users\\digeff\\AppData\\Local\\Temp\\2689D069D40B1EFF4B570B2DB12506073980\\5~~';
    const sourcePath = `${remoteFilePrefix}\\C$\\workspace\\NewBlazorWASM\\NewBlazorWASM\\Pages\\Counter.razor`;
    const regexp = createBlazorSourcePathResolver(remoteFilePrefix).absolutePathToUrlRegexp(
      sourcePath,
    );

    // This regexp was generated from running the real scenario, verifying that the breakpoint with this regexp works, and then copying it here
    expect(regexp).to.equal(
      'dotnet://.*\\.dll/[cC]\\/[wW][oO][rR][kK][sS][pP][aA][cC][eE]\\/[nN][eE][wW][bB][lL][aA][zZ][oO][rR][wW][aA][sS][mM]\\/' +
        '[nN][eE][wW][bB][lL][aA][zZ][oO][rR][wW][aA][sS][mM]\\/[pP][aA][gG][eE][sS]\\/[cC][oO][uU][nN][tT][eE][rR]\\.[rR][aA][zZ][oO][rR]',
    );
  });
});
