/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { interfaces } from 'inversify';
import { IDisposable } from './common/disposable';
import { promises as fsPromises } from 'fs';
import { ObservableMap } from './common/datastructure/observableMap';

/**
 * The IOC container itself.
 */
export const IContainer = Symbol('IContainer');

/**
 * Token for the string that points to a temporary storage directory.
 */
export const StoragePath = Symbol('StoragePath');

/**
 * Key for the Dap.InitializeParams.
 */
export const IInitializeParams = Symbol('IInitializeParams');

/**
 * Key for the VS Code API. Only available in the extension.
 */
export const VSCodeApi = Symbol('VSCodeApi');

/**
 * Key for whether vs code services are available here.
 */
export const IsVSCode = Symbol('IsVSCode');

/**
 * Key for the vscode.ExtensionContext. Only available in the extension.
 */
export const ExtensionContext = Symbol('ExtensionContext');

/**
 * Process environment.
 */
export const ProcessEnv = Symbol('ProcessEnv');

/**
 * Injection for the execa module.
 * @see https://github.com/sindresorhus/execa
 */
export const Execa = Symbol('execa');

/**
 * Injection for the `fs.promises` module.
 */
export const FS = Symbol('FS');

/**
 * Location the extension is running.
 */
export const ExtensionLocation = 'ExtensionLocation';

/**
 * FS promises alias, for easy import/completion
 */
export type FsPromises = typeof fsPromises;

/**
 * Symbol for `vscode-js-debug-browsers`'s IBrowserFinder.
 */
export const BrowserFinder = Symbol('IBrowserFinder');

/**
 * Location the extension is running in.
 */
export type ExtensionLocation = 'local' | 'remote';

export type SessionSubStates = ObservableMap<string, string>;

/**
 * An ObservableMap<string, string> containing custom substates for sessions.
 * This is used to add the "profiling" state to session names. Eventually, this
 * handling may move to DAP.
 *
 * @see https://github.com/microsoft/vscode/issues/94812
 * @see https://github.com/microsoft/debug-adapter-protocol/issues/108
 */
export const SessionSubStates = Symbol('SessionSubStates');

const toDispose = new WeakMap<interfaces.Container, IDisposable[]>();

/**
 * An inversify `onActivation` that registers the instance to be disposed
 * of when `disposeContainer` is called.
 */
export const trackDispose = <T>(ctx: interfaces.Context, service: T): T => {
  if (!(typeof service === 'object' && service && 'dispose' in service)) {
    return service;
  }

  const disposable = (service as unknown) as IDisposable;
  const list = toDispose.get(ctx.container);
  if (!list) {
    toDispose.set(ctx.container, [disposable]);
  } else {
    list.push(disposable);
  }

  return service;
};

/**
 * Disposes all disposable services in the given container.
 */
export const disposeContainer = (container: interfaces.Container) => {
  toDispose.get(container)?.forEach(d => d.dispose());
};
