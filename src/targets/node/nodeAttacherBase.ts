/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { injectable } from 'inversify';
import { getSourceSuffix } from '../../adapter/templates';
import Cdp from '../../cdp/api';
import { EnvironmentVars } from '../../common/environmentVars';
import { LogTag } from '../../common/logging';
import { delay } from '../../common/promiseUtil';
import { AnyNodeConfiguration } from '../../configuration';
import { NodeLauncherBase } from './nodeLauncherBase';

/** Variables that should be appended rather than replaced in the environment */
const appendVars: readonly string[] = ['NODE_OPTIONS', 'VSCODE_INSPECTOR_OPTIONS'];

/**
 * Base class that implements common matters for attachment.
 */
@injectable()
export abstract class NodeAttacherBase<T extends AnyNodeConfiguration> extends NodeLauncherBase<T> {
  protected async appendEnvironmentVariables(cdp: Cdp.Api, vars: EnvironmentVars) {
    const expression =
      `typeof Deno==='object'?'deno':typeof process==='undefined'||process.pid===undefined?'process not defined':(()=>{`
      + Object.entries(vars.defined())
        .map(([key, value]) => {
          const k = JSON.stringify(key);
          return appendVars.includes(key)
            ? `process.env[${k}]=(process.env[${k}]||'')+${JSON.stringify(value)}`
            : `process.env[${k}]=${JSON.stringify(value)}`;
        })
        .join(';')
      + '})()'
      + getSourceSuffix();

    for (let retries = 0; retries < 200; retries++) {
      const result = await cdp.Runtime.evaluate({
        contextId: 1,
        returnByValue: true,
        expression,
      });

      if (!result) {
        this.logger.error(LogTag.RuntimeTarget, 'Undefined result setting child environment vars');
        return;
      }

      if (!result.exceptionDetails && result.result.value !== 'process not defined') {
        return;
      }

      this.logger.error(LogTag.RuntimeTarget, 'Error setting child environment vars', result);
      await delay(50);
    }
  }
}
