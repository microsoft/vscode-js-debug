/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import Dap from './api';

export class ProtocolError extends Error {
  public get cause(): Dap.Message {
    return this._cause;
  }

  protected _cause: Dap.Message;

  constructor(cause: Dap.Message | Dap.Error) {
    super('__errorMarker' in cause ? cause.error.format : cause.format);
    this._cause = '__errorMarker' in cause ? cause.error : cause;
  }
}
