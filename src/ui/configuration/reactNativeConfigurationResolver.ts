/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { inject, injectable } from 'inversify';
import * as vscode from 'vscode';
import { CancellationToken } from 'vscode';
import { IResourceProvider } from '../../adapter/resourceProvider';
import { DebugType } from '../../common/contributionUtils';
import {
  applyNodeDefaults,
  IReactNativeAttachConfiguration,
  ResolvingConfiguration,
} from '../../configuration';
import { ExtensionContext } from '../../ioc-extras';
import { pickReactNativeProcess } from '../reactNativeProcessPicker';
import { BaseConfigurationResolver } from './baseConfigurationResolver';

/**
 * Configuration resolver for React Native attach. It reuses the Node
 * attach machinery, but resolves the target by querying the dev server's
 * `/json/list` endpoint and prompting the user to pick one. The chosen target's
 * inspector WebSocket URL is written to `websocketAddress`, which the Node
 * attacher connects to directly.
 */
@injectable()
export class ReactNativeConfigurationResolver
  extends BaseConfigurationResolver<IReactNativeAttachConfiguration>
{
  constructor(
    @inject(ExtensionContext) context: vscode.ExtensionContext,
    @inject(IResourceProvider) private readonly resourceProvider: IResourceProvider,
  ) {
    super(context);
  }

  /**
   * @override
   */
  protected async resolveDebugConfigurationAsync(
    _folder: vscode.WorkspaceFolder | undefined,
    config: ResolvingConfiguration<IReactNativeAttachConfiguration>,
    cancellationToken?: CancellationToken,
  ): Promise<IReactNativeAttachConfiguration | undefined> {
    // React Native is attach-only: js-debug connects to an already-running app
    // via the dev server, it never launches the app itself. (`request` is typed
    // as `attach`, but the raw config from the user can be anything.)
    const request: string = config.request;
    if (request !== 'attach') {
      throw new Error(
        l10n.t('`{0}` configurations only support the `attach` request.', DebugType.ReactNative),
      );
    }

    // The target's WebSocket URL is discovered from the dev server, so users
    // must never provide it themselves.
    if (config.websocketAddress) {
      throw new Error(
        l10n.t(
          '`websocketAddress` is not supported for `{0}` configurations.',
          DebugType.ReactNative,
        ),
      );
    }

    // The dev server port comes from the launch config; default to Metro's 8081.
    const port = typeof config.port === 'number' ? config.port : 8081;
    const websocketAddress = await pickReactNativeProcess(
      this.resourceProvider,
      port,
      cancellationToken,
    );
    if (!websocketAddress) {
      return undefined; // cancelled
    }

    config.websocketAddress = websocketAddress;
    return applyNodeDefaults(config) as IReactNativeAttachConfiguration;
  }

  /**
   * @override
   */
  protected getType() {
    return DebugType.ReactNative as const;
  }
}
