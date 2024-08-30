/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { IBrowserFinder } from '@vscode/js-debug-browsers';
import { inject, injectable, tagged } from 'inversify';
import { DebugType } from '../../common/contributionUtils';
import { canAccess } from '../../common/fsUtils';
import { ILogger } from '../../common/logging';
import { ISourcePathResolver } from '../../common/sourcePathResolver';
import { AnyLaunchConfiguration, IChromeLaunchConfiguration } from '../../configuration';
import Dap from '../../dap/api';
import { browserNotFound } from '../../dap/errors';
import { ProtocolError } from '../../dap/protocolError';
import { BrowserFinder, FS, FsPromises, IInitializeParams, StoragePath } from '../../ioc-extras';
import { BrowserLauncher } from './browserLauncher';

@injectable()
export class ChromeLauncher extends BrowserLauncher<IChromeLaunchConfiguration> {
  constructor(
    @inject(StoragePath) storagePath: string,
    @inject(ILogger) logger: ILogger,
    @inject(BrowserFinder)
    @tagged('browser', 'chrome')
    protected readonly browserFinder: IBrowserFinder,
    @inject(FS) fs: FsPromises,
    @inject(ISourcePathResolver) pathResolver: ISourcePathResolver,
    @inject(IInitializeParams) initializeParams: Dap.InitializeParams,
  ) {
    super(storagePath, logger, pathResolver, initializeParams, fs);
  }

  /**
   * @inheritdoc
   */
  protected resolveParams(params: AnyLaunchConfiguration) {
    return params.type === DebugType.Chrome
        && params.request === 'launch'
        && params.browserLaunchLocation === 'workspace'
      ? params
      : undefined;
  }

  /**
   * @inheritdoc
   */
  protected async findBrowserPath(executablePath: string): Promise<string> {
    const resolvedPath = await this.findBrowserByExe(this.browserFinder, executablePath);
    if (!resolvedPath || !(await canAccess(this.fs, resolvedPath))) {
      throw new ProtocolError(
        browserNotFound(
          'Chrome',
          executablePath,
          (await this.browserFinder.findAll()).map(b => b.quality),
        ),
      );
    }

    return resolvedPath;
  }
}
