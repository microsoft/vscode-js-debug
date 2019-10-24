// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { createServer } from 'http-server';
import { IFixture } from './fixture';
import { URL } from 'url';
import { HttpOrHttpsServer } from '../types/server';
import { TestProjectSpec } from '../framework/frameworkTestSupport';
import { IChromeLaunchConfiguration } from '../../configuration';
import { AddressInfo } from 'net';

async function createServerAsync(root: string): Promise<HttpOrHttpsServer> {
  const server = createServer({ root });
  return await new Promise((resolve, reject) => {
    // logger.log(`About to launch web-server on: ${root}`);
    server.listen(0, '127.0.0.1', function(this: HttpOrHttpsServer, error?: any) {
      if (error) {
        reject(error);
      } else {
        // logger.log(`Web-server on: ${root} listening on: ${JSON.stringify(this.address())}`);
        resolve(this); // We return the this pointer which is the internal server object, which has access to the .address() method
      }
    });
  });
}

async function closeServer(server: HttpOrHttpsServer): Promise<void> {
  // logger.log(`Closing web-server`);
  await new Promise((resolve, reject) => {
    server.close((error?: any) => {
      if (error) {
        // logger.log('Error closing server in teardown: ' + (error && error.message));
        reject(error);
      } else {
        resolve();
      }
    });
  });
  // logger.log(`Web-server closed`);
}

/**
 * Launch a web-server for the test project listening on the default port
 */
export class LaunchWebServer implements IFixture {
  private constructor(
    private readonly _server: HttpOrHttpsServer,
    public readonly testSpec: TestProjectSpec,
  ) {}

  public static async launch(testSpec: TestProjectSpec): Promise<LaunchWebServer> {
    return new LaunchWebServer(await createServerAsync(testSpec.props.webRoot), testSpec);
  }

  public get url(): URL {
    return new URL(`http://localhost:${this.port}/`);
  }

  public get launchConfig(): IChromeLaunchConfiguration {
    return Object.assign({}, this.testSpec.props.launchConfig, {
      url: this.url.toString(),
    }) as IChromeLaunchConfiguration; // TODO@rob
  }

  public get port(): number {
    const address = this._server.address();
    return (address as AddressInfo).port;
  }

  public async cleanUp(): Promise<void> {
    await closeServer(this._server);
  }

  public toString(): string {
    return `LaunchWebServer`;
  }
}

export class ProvideStaticUrl implements IFixture {
  public constructor(public readonly url: URL, public readonly testSpec: TestProjectSpec) {}

  public get launchConfig(): IChromeLaunchConfiguration {
    return {
      ...this.testSpec.props.launchConfig,
      url: this.url.href,
    } as IChromeLaunchConfiguration; // TODO@rob
  }
  cleanUp() {}
}
