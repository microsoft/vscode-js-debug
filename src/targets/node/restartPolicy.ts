import { INodeLaunchConfiguration } from '../../configuration';
import { IStopMetadata } from '../targets';

/**
 * Creates restart policies from the configuration.
 */
export class RestartPolicyFactory {
  public create(config: INodeLaunchConfiguration): IRestartPolicy {
    if (!config.restart) {
      return new NeverRestartPolicy();
    }

    return new StaticRestartPolicy(1000);
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
  next(result: IStopMetadata): IRestartPolicy | undefined;
}

/**
 * Restart policy with a static delay.
 * @see https://github.com/microsoft/vscode-pwa/issues/26
 */
class StaticRestartPolicy implements IRestartPolicy {
  constructor(public readonly delay: number) {}

  public next(result: IStopMetadata) {
    if (result.killed || result.code === 0) {
      return;
    }

    return this;
  }
}

class NeverRestartPolicy implements IRestartPolicy {
  public readonly delay = -1;

  public next() {
    return undefined;
  }
}
