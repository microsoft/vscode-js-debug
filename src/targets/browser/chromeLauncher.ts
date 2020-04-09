/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { DebugType } from '../../common/contributionUtils';
import { IChromeLaunchConfiguration, AnyLaunchConfiguration } from '../../configuration';
import { injectable, inject, tagged } from 'inversify';
import { BrowserLauncher } from './browserLauncher';
import { StoragePath, FS, FsPromises, BrowserFinder, IInitializeParams } from '../../ioc-extras';
import { ILogger } from '../../common/logging';
import { once } from '../../common/objUtils';
import { canAccess } from '../../common/fsUtils';
import { ProtocolError, browserNotFound } from '../../dap/errors';
import { IBrowserFinder, isQuality } from 'vscode-js-debug-browsers';
import { ISourcePathResolver } from '../../common/sourcePathResolver';
import Dap from '../../dap/api';

@injectable()
export class ChromeLauncher extends BrowserLauncher<IChromeLaunchConfiguration> {
  constructor(
    @inject(StoragePath) storagePath: string,
    @inject(ILogger) logger: ILogger,
    @inject(BrowserFinder)
    @tagged('browser', 'chrome')
    protected readonly browserFinder: IBrowserFinder,
    @inject(FS)
    private readonly fs: FsPromises,
    @inject(ISourcePathResolver) pathResolver: ISourcePathResolver,
    @inject(IInitializeParams) initializeParams: Dap.InitializeParams,
  ) {
    super(storagePath, logger, pathResolver, initializeParams);
  }

  /**
   * @inheritdoc
   */
  protected resolveParams(params: AnyLaunchConfiguration) {
    return params.type === DebugType.Chrome &&
      params.request === 'launch' &&
      params.browserLaunchLocation === 'workspace'
      ? params
      : undefined;
  }

  /**
   * @inheritdoc
   */
  protected async findBrowserPath(executablePath: string): Promise<string> {
    let resolvedPath: string | undefined;

    const discover = once(() => this.browserFinder.findAll());
    if (isQuality(executablePath)) {
      resolvedPath = (await discover()).find(r => r.quality === executablePath)?.path;
    } else {
      resolvedPath = executablePath;
    }

    if (!resolvedPath || !(await canAccess(this.fs, resolvedPath))) {
      throw new ProtocolError(
        browserNotFound(
          'Chrome',
          executablePath,
          (await discover()).map(b => b.quality),
        ),
      );
    }

    return resolvedPath;
  }
}
