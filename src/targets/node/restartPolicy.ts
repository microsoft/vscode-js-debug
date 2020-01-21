/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { assertNever } from '../../common/objUtils';

export type AnyRestartOptions =
  | boolean
  | { exponential: Partial<IExponentialRestartOptions> }
  | { static: Partial<IStaticRestartOptions> };

const defaultOptions: IExponentialRestartOptions = {
  maxDelay: 10000,
  maxAttempts: 10,
  exponent: 2,
  initialDelay: 128,
};

/**
 * Creates restart policies from the configuration.
 */
export class RestartPolicyFactory {
  public create(config: AnyRestartOptions): IRestartPolicy {
    if (config === false) {
      return new NeverRestartPolicy();
    }

    if (config === true) {
      return new ExponentialRestartPolicy(defaultOptions);
    }

    if ('exponential' in config) {
      return new ExponentialRestartPolicy({ ...defaultOptions, ...config.exponential });
    }

    if ('static' in config) {
      return new StaticRestartPolicy({
        maxAttempts: defaultOptions.maxAttempts,
        delay: 1000,
        ...config.static,
      });
    }

    throw assertNever(config, 'Unexpected value for restart configuration');
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
}

export interface IExponentialRestartOptions {
  /**
   * Maximum delay, in milliseconds. Defaults to 10s.
   */
  maxDelay: number;

  /**
   * Maximum retry attempts.  Defaults to 10.
   */
  maxAttempts: number;

  /**
   * Backoff exponent. Defaults to 2.
   */
  exponent: number;

  /**
   * The initial, first delay of the backoff, in milliseconds.
   * Defaults to 128ms.
   */
  initialDelay: number;
}

/**
 * A simple, jitter-free exponential backoff.
 */
class ExponentialRestartPolicy implements IRestartPolicy {
  public get delay() {
    return Math.min(
      this.options.maxDelay,
      this.options.initialDelay * this.options.exponent ** this.attempt,
    );
  }

  constructor(
    private readonly options: IExponentialRestartOptions,
    private readonly attempt: number = 0,
  ) {}

  public next() {
    return this.attempt === this.options.maxAttempts
      ? undefined
      : new ExponentialRestartPolicy(this.options, this.attempt + 1);
  }
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
}

class NeverRestartPolicy implements IRestartPolicy {
  public readonly delay = -1;

  public next() {
    return undefined;
  }
}
