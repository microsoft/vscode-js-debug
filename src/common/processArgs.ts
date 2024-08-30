/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { once } from './objUtils';

export const argsToMap = (args: ReadonlyArray<string>) => {
  const map: { [key: string]: string | null } = {};
  for (const arg of args) {
    const delimiter = arg.indexOf('=');
    if (delimiter === -1) {
      map[arg] = null;
    } else {
      map[arg.slice(0, delimiter)] = arg.slice(delimiter + 1);
    }
  }

  return map;
};

export const mapToArgs = (map: { [key: string]: string | null | undefined }) => {
  const out: string[] = [];
  for (const key of Object.keys(map)) {
    const value = map[key];
    if (value === undefined) {
      continue;
    }

    out.push(value === null ? key : `${key}=${value}`);
  }

  return out;
};

/**
 * Type used for managing the list of arguments passed to the browser.
 */
export class ProcessArgs {
  protected readonly argMap = once(() => argsToMap(this.args));

  constructor(private readonly args: ReadonlyArray<string> = []) {}

  /**
   * Adds or overwrites an argument.
   */
  public add(key: string, value: string | null = null): this {
    return this.newThis(mapToArgs({ ...this.argMap(), [key]: value }));
  }

  /**
   * Gets an argument.
   */
  public get(key: string) {
    const am = this.argMap();
    return am.hasOwnProperty(key) ? am[key] : undefined;
  }

  /**
   * Removes an argument.
   */
  public remove(key: string): this {
    return this.newThis(mapToArgs({ ...this.argMap(), [key]: undefined }));
  }

  /**
   * Merges the set of arguments into this one.
   */
  public merge(args: ReadonlyArray<string> | ProcessArgs): this {
    return this.newThis(
      mapToArgs({
        ...this.argMap(),
        ...(args instanceof ProcessArgs ? args.argMap() : argsToMap(args)),
      }),
    );
  }

  /**
   * Returns a new set of browser args that pass the predicate.
   */
  public filter(predicate: (key: string, value: string | null) => boolean): this {
    const args = this.argMap();
    const out: string[] = [];
    for (const key of Object.keys(args)) {
      const value = args[key];
      if (!predicate(key, value)) {
        continue;
      }

      out.push(value === null ? key : `${key}=${value}`);
    }

    return this.newThis(out);
  }

  /**
   * Gets the array of arguments.
   */
  public toArray() {
    return this.args.slice();
  }

  private newThis(args: ReadonlyArray<string>) {
    type X = this;
    return new (this.constructor as { new(args: readonly string[]): X })(args);
  }
}
