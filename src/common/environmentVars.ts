/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import * as path from 'path';
import {
  caseInsensitiveMerge,
  getCaseInsensitiveProperty,
  mapValues,
  once,
  removeNulls,
  removeUndefined,
} from './objUtils';

/**
 * @see https://github.com/microsoft/vscode/blob/97664e1452b68b5b6eedce95eaa79956fada01b5/src/vs/base/common/processes.ts#L104
 */
export function getSanitizeProcessEnv(base: NodeJS.ProcessEnv) {
  const keysToRemove = [
    /^APPLICATION_INSIGHTS_NO_DIAGNOSTIC_CHANNEL$/i,
    /^ELECTRON_.+$/i,
    /^GOOGLE_API_KEY$/i,
    /^VSCODE_.+$/i,
    /^SNAP(|_.*)$/i,
    /^GDK_PIXBUF_.+$/i,
  ];

  return new EnvironmentVars(base).map((key, value) =>
    keysToRemove.some(re => re.test(key)) ? undefined : value
  );
}

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
   * Process environment, sanitized of any VS Code specific variables.
   */
  public static readonly processEnv = once(() => getSanitizeProcessEnv(process.env));

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
  public readonly defined = once(() => removeNulls(this.value));

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
  public addToPath(
    location: string,
    prependOrAppend: 'prepend' | 'append' = 'append',
    includePlaceholder = false,
  ) {
    const prop = EnvironmentVars.platform === 'win32' ? 'Path' : 'PATH';
    const delimiter = EnvironmentVars.platform === 'win32'
      ? path.win32.delimiter
      : path.posix.delimiter;

    let value = this.lookup(prop);
    if (includePlaceholder && !value) {
      value = `\${env:${prop}}`;
    }

    if (!value) {
      value = location;
    } else if (prependOrAppend === 'append') {
      value = value + delimiter + location;
    } else {
      value = location + delimiter + value;
    }

    return this.update(prop, value);
  }

  /**
   * Adds a value to the NODE_OPTIONS arg.
   */
  public addNodeOption(option: string) {
    const existing = this.lookup('NODE_OPTIONS');
    return this.update('NODE_OPTIONS', existing ? `${existing} ${option}` : option);
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
   * Maps the environment variables. If the mapper function returns undefined,
   * the value is not included in the resulting set of variables.
   */
  public map(mapper: (key: string, value: string | null) => string | null | undefined) {
    return new EnvironmentVars(mapValues(this.value, (v, k) => mapper(k, v)));
  }

  /**
   * Merges the sets of environment variables together.
   */
  public static merge(
    ...vars: (EnvironmentVars | { [key: string]: string | null | undefined })[]
  ): EnvironmentVars {
    const objects = vars.map(v => (v instanceof EnvironmentVars ? v.value : v));
    const result = EnvironmentVars.platform === 'win32'
      ? caseInsensitiveMerge(...objects)
      : Object.assign({}, ...objects);

    return new EnvironmentVars(result);
  }
}
