/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { interfaces } from 'inversify';
import { IDisposable } from './common/disposable';
import { promises as fsPromises } from 'fs';

/**
 * Token for the string that points to a temporary storage directory.
 */
export const StoragePath = Symbol('StoragePath');

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
 * FS promises alias, for easy import/completion
 */
export type FsPromises = typeof fsPromises;

/**
 * Symbol for `vscode-js-debug-browsers`'s IBrowserFinder.
 */
export const BrowserFinder = Symbol('IBrowserFinder');

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
