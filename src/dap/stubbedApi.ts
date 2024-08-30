/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { SinonStub, stub } from 'sinon';
import Dap from './api';

export type StubDapApi =
  & {
    [K in keyof Dap.Api]: Dap.Api[K] extends (...args: infer A) => infer R ? SinonStub<A, R>
      : Dap.Api[K];
  }
  & { actual: Dap.Api };

export const stubbedDapApi = (): StubDapApi => {
  const stubs = new Map<string, SinonStub>();
  const proxy = new Proxy(
    {},
    {
      get: (target, methodName: string) => {
        if (methodName === 'actual') {
          return target;
        }

        let s = stubs.get(methodName);
        if (!s) {
          s = stub();
          stubs.set(methodName, s);
        }

        return s;
      },
    },
  ) as StubDapApi;

  return proxy;
};
