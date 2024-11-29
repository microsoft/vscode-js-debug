/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import type { IDebugTerminalOptionsProvider, IExports } from '@vscode/js-debug';
import { inject, injectable } from 'inversify';
import { IDebugTerminalOptionsProviders } from '../ioc-extras';

@injectable()
export class ExtensionApiFactory {
  constructor(
    @inject(IDebugTerminalOptionsProviders) private readonly debugTerminalOptionsProviders: Set<
      IDebugTerminalOptionsProvider
    >,
  ) {}

  public create(): IExports {
    return {
      registerDebugTerminalOptionsProvider: provider => {
        this.debugTerminalOptionsProviders.add(provider);
        return { dispose: () => this.debugTerminalOptionsProviders.delete(provider) };
      },
    };
  }
}
