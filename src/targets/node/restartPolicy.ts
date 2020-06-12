/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { injectable } from 'inversify';

export type AnyRestartOptions = boolean | Partial<IStaticRestartOptions>;

/**
 * Creates restart policies from the configuration.
 */
@injectable()
export class RestartPolicyFactory {
  public create(config: AnyRestartOptions): IRestartPolicy {
    if (config === false) {
      return new NeverRestartPolicy();
    }

    if (config === true) {
      return new StaticRestartPolicy({ maxAttempts: Infinity, delay: 1000 });
    }

    return new StaticRestartPolicy({
      maxAttempts: config.maxAttempts ?? Infinity,
      delay: config.delay ?? 1000,
    });
  }
}

/**
 * Configures how the program should be restarted if it crashes.
 */
export interface IRestartPolicy {
  readonly delay: number;

  /**
   * Returns the delay before the server should be restarted, or undefined
   * if no restart should occur.
   */
  next(): IRestartPolicy | undefined;

  /**
   * Resets the policy.
   */
  reset(): IRestartPolicy;
}

export interface IStaticRestartOptions {
  /**
   * Constant delay.
   */
  delay: number;

  /**
   * Maximum retry attempts. Defaults to 10.
   */
  maxAttempts: number;
}

/**
 * Restart policy with a static delay.
 * @see https://github.com/microsoft/vscode-pwa/issues/26
 */
class StaticRestartPolicy implements IRestartPolicy {
  public get delay() {
    return this.options.delay;
  }

  constructor(private readonly options: IStaticRestartOptions, private readonly attempt = 0) {}

  public next() {
    return this.attempt === this.options.maxAttempts
      ? undefined
      : new StaticRestartPolicy(this.options, this.attempt + 1);
  }

  public reset() {
    return this.attempt ? new StaticRestartPolicy(this.options) : this;
  }
}

class NeverRestartPolicy implements IRestartPolicy {
  public readonly delay = -1;

  public next() {
    return undefined;
  }

  public reset() {
    return this;
  }
}
