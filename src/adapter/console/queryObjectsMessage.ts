/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as nls from 'vscode-nls';
import Cdp from '../../cdp/api';
import Dap from '../../dap/api';
import { previewRemoteObject } from '../objectPreview';
import { previewThis } from '../templates/previewThis';
import { Thread } from '../threads';
import { IConsoleMessage } from './consoleMessage';

const localize = nls.loadMessageBundle();

/**
 * Message sent as the result of querying objects on the runtime.
 */
export class QueryObjectsMessage implements IConsoleMessage {
  constructor(private readonly protoObj: Cdp.Runtime.RemoteObject, private readonly cdp: Cdp.Api) {}

  public async toDap(thread: Thread): Promise<Dap.OutputEventParams> {
    if (!this.protoObj.objectId) {
      return {
        category: 'stderr',
        output: localize('queryObject.invalidObject', 'Only objects can be queried'),
      };
    }

    const response = await this.cdp.Runtime.queryObjects({
      prototypeObjectId: this.protoObj.objectId,
      objectGroup: 'console',
    });

    await this.cdp.Runtime.releaseObject({ objectId: this.protoObj.objectId });
    if (!response) {
      return {
        category: 'stderr',
        output: localize('queryObject.couldNotQuery', 'Could not query the provided object'),
      };
    }

    let withPreview: Cdp.Runtime.RemoteObject;
    try {
      withPreview = await previewThis({
        cdp: this.cdp,
        args: [],
        objectId: response.objects.objectId,
        objectGroup: 'console',
        generatePreview: true,
      });
    } catch (e) {
      return {
        category: 'stderr',
        output: localize('queryObject.errorPreview', 'Could generate preview: {0}', e.message),
      };
    }

    const text = '\x1b[32mobjects: ' + previewRemoteObject(withPreview, 'repl') + '\x1b[0m';
    const variablesReference =
      (await thread.replVariables.createVariableForOutput(text, [withPreview])) || 0;

    return {
      category: 'stdout',
      output: '',
      variablesReference,
    };
  }
}
