/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import {
  getCaseInsensitiveProperty,
  caseInsensitiveMerge,
  removeUndefined,
  removeNulls,
} from './objUtils';
import * as path from 'path';

/**
 * Container for holding sets of environment variables. Deals with case
 * sensitivity issues in Windows.
 */
export class EnvironmentVars {
  /**
   * Current process platform.
   */
  public static platform = process.platform;

  /**
   * An empty set of environment variables.
   */
  public static readonly empty = new EnvironmentVars({});

  /**
   * Current environment variables.
   */
  public readonly value: Readonly<{ [key: string]: string | null }>;

  constructor(vars?: { [key: string]: string | null | undefined }) {
    this.value = vars ? removeUndefined(vars) : {};
  }

  /**
   * Returns a map of defined environment variables.
   */
  public defined() {
    return removeNulls(this.value);
  }

  /**
   * Looks up an environment variable property.
   */
  public lookup(prop: string): string | null | undefined {
    return EnvironmentVars.platform === 'win32'
      ? getCaseInsensitiveProperty(this.value, prop)
      : this.value[prop];
  }

  /**
   * Adds the given location to the environment PATH.
   */
  public addToPath(location: string) {
    const prop = EnvironmentVars.platform === 'win32' ? 'Path' : 'PATH';
    const delimiter =
      EnvironmentVars.platform === 'win32' ? path.win32.delimiter : path.posix.delimiter;

    let value = this.lookup(prop);
    if (!value) {
      value = location;
    } else {
      value = value + delimiter + location;
    }

    return this.update(prop, value);
  }

  /**
   * Creates a new set of environment variables with the given update.
   */
  public update(prop: string, value: string | null) {
    return EnvironmentVars.merge(this, { [prop]: value });
  }

  /**
   * Merges these environment variables with the other set.
   */
  public merge(...vars: (EnvironmentVars | { [key: string]: string | null | undefined })[]) {
    return EnvironmentVars.merge(this, ...vars);
  }

  /**
   * Merges the sets of environment variables together.
   */
  public static merge(
    ...vars: (EnvironmentVars | { [key: string]: string | null | undefined })[]
  ): EnvironmentVars {
    const objects = vars.map(v => (v instanceof EnvironmentVars ? v.value : v));
    const result =
      EnvironmentVars.platform === 'win32'
        ? caseInsensitiveMerge(...objects)
        : Object.assign({}, ...objects);

    return new EnvironmentVars(result);
  }
}
