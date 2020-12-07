/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { useCallback, useState } from 'preact/hooks';

declare const acquireVsCodeApi: <T>() => {
  getState(): T;
  setState(data: T): void;
};

const api = acquireVsCodeApi<{ componentState?: { [key: string]: unknown } }>();

const getComponentState = <T extends unknown>(name: string, defaultValue: T) => {
  const states = api.getState()?.componentState || {};
  return states.hasOwnProperty(name) ? (states[name] as T) : defaultValue;
};

const setComponentState = (name: string, value: unknown) => {
  const state = api.getState();
  api.setState({ ...state, componentState: { ...state?.componentState, [name]: value } });
};

export const usePersistedState = <T extends unknown>(name: string, initialValue: T) => {
  const [value, setValue] = useState(() => getComponentState(name, initialValue));
  const setWrapped = useCallback(
    (value: T) => {
      setComponentState(name, value);
      setValue(value);
    },
    [name, setValue],
  );

  return [value, setWrapped] as const;
};
