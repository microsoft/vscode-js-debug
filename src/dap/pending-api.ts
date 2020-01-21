/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import Dap from './api';
import { getDeferred } from '../common/promiseUtil';

/**
 * A PendingDapApi buffers requests until connected to a real, physical DAP API.
 */
export interface IPendingDapApi extends Dap.Api {
  /**
   * Attaches the pending API to the given DAP API.
   */
  connect(dap: Dap.Api): void;

  /**
   * Detaches the underlying DAP, resetting state.
   */
  disconnect(): void;
}

export const createPendingDapApi = (): IPendingDapApi => {
  let underlying: Dap.Api | undefined;
  let queue = getDeferred<Dap.Api>();

  const get = <K extends keyof Dap.Api>(_target: {}, method: K) => {
    if ((method as unknown) === 'connect') {
      return (api: Dap.Api) => {
        queue.resolve(api);
        underlying = api;
      };
    }

    if ((method as unknown) === 'disconnect') {
      return () => {
        queue = getDeferred();
        underlying = undefined;
      };
    }

    return async (...args: unknown[]) => {
      const api = underlying || (await queue.promise);
      return (api[method] as Function)(...args);
    };
  };

  return new Proxy({}, { get }) as IPendingDapApi;
};
