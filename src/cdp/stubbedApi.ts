/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { SinonStub, stub } from 'sinon';
import Cdp from './api';

export type StubCdpApi =
  & {
    [K in keyof Cdp.Api]: {
      [K2 in keyof Cdp.Api[K]]: Cdp.Api[K][K2] extends (...args: infer A) => infer R
        ? SinonStub<A, R>
        : Cdp.Api[K][K2];
    };
  }
  & { actual: Cdp.Api };

export const stubbedCdpApi = (): StubCdpApi => {
  const stubs = new Map<string, SinonStub>();
  const proxy = new Proxy(
    {},
    {
      get: (_target, domain: string) => {
        if (domain === 'actual') {
          return proxy;
        }

        return new Proxy(
          {},
          {
            get: (_target, method: string) => {
              let s = stubs.get(`${domain}.${method}`);
              if (!s) {
                s = stub();
                stubs.set(`${domain}.${method}`, s);
              }

              return s;
            },
          },
        );
      },
    },
  ) as StubCdpApi;

  return proxy;
};
