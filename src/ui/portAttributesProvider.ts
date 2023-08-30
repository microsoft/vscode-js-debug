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
  implements IExtensionContribution, PortAttributesProvider
{
  /** Cache of used ports (#1092) */
  private cachedResolutions: string[] = new Array(16).fill('');
  /** Index counter for the next cached resolution index in the list */
  private cachedResolutionIndex = 0;

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
  public async providePortAttributes({ port, pid }: { port: number; pid?: number }) {
    if (pid && this.cachedResolutions.includes(`${port}:${pid}`)) {
      return { port, autoForwardAction: PortAutoForwardAction.Ignore };
    }

    if (!(await this.leaseTracker.isRegistered(port))) {
      return undefined;
    }

    if (pid) {
      const index = this.cachedResolutionIndex++ % this.cachedResolutions.length;
      this.cachedResolutions[index] = `${port}:${pid}`;
    }

    return { port, autoForwardAction: PortAutoForwardAction.Ignore };
  }
}
