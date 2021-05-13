/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { AnyLaunchConfiguration } from '../configuration';
import { EventEmitter, IEvent } from './events';

export type MutableLaunchConfig = AnyLaunchConfiguration & {
  update(newValue: AnyLaunchConfiguration): void;
  onChange: IEvent<void>;
};

export const MutableLaunchConfig = Symbol('MutableLaunchConfig');

export const createMutableLaunchConfig = (source: AnyLaunchConfiguration) => {
  const change = new EventEmitter<void>();

  return new Proxy(
    {},
    {
      ownKeys() {
        return Object.keys(source);
      },
      get(_target, key) {
        switch (key) {
          case 'update':
            return (value: AnyLaunchConfiguration) => {
              source = value;
              change.fire();
            };
          case 'onChange':
            return change.event;
          default:
            return source[key as keyof AnyLaunchConfiguration];
        }
      },
    },
  );
};
