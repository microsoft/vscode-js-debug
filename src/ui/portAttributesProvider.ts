/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { inject, injectable } from 'inversify';
import { ExtensionContext, PortAttributesProvider, PortAutoForwardAction, workspace } from 'vscode';
import { IPortLeaseTracker } from '../adapter/portLeaseTracker';
import { DefaultJsDebugPorts } from '../common/findOpenPort';
import { IExtensionContribution } from '../ioc-extras';

@injectable()
export class JsDebugPortAttributesProvider
  implements IExtensionContribution, PortAttributesProvider {
  constructor(@inject(IPortLeaseTracker) private readonly leaseTracker: IPortLeaseTracker) {}

  /**
   * @inheritdoc
   */
  public register(context: ExtensionContext) {
    if (typeof workspace.registerPortAttributesProvider === 'function') {
      context.subscriptions.push(
        workspace.registerPortAttributesProvider(
          { portRange: [DefaultJsDebugPorts.Min, DefaultJsDebugPorts.Max] },
          this,
        ),
      );
    }
  }

  /**
   * @inheritdoc
   */
  public providePortAttributes(ports: number[]) {
    return Promise.all(
      ports.map(async port => ({
        port,
        autoForwardAction: (await this.leaseTracker.isRegistered(port))
          ? PortAutoForwardAction.Ignore
          : PortAutoForwardAction.Notify,
      })),
    );
  }
}
