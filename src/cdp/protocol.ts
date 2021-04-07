/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

export namespace CdpProtocol {
  export interface ICommand {
    id?: number;
    method: string;
    params: object;
    sessionId?: string;
  }

  export interface IError {
    id: number;
    method?: string;
    error: { code: number; message: string };
    sessionId?: string;
  }

  export interface ISuccess {
    id: number;
    result: object;
    sessionId?: string;
  }

  export type Message = ICommand | ISuccess | IError;
}
