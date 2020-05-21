/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { join } from 'path';
import * as net from 'net';
import { RawPipeTransport } from '../../cdp/rawPipeTransport';
import { Logger } from '../../common/logging/logger';
import Cdp from '../../cdp/api';
import { WebSocketTransport } from '../../cdp/webSocketTransport';
import { NeverCancelled } from '../../common/cancellation';
import { ITransport } from '../../cdp/transport';
import { IDisposable } from '../../common/disposable';
import { EventEmitter } from '../../common/events';
import { spawn } from 'child_process';
import { IStopMetadata } from '../targets';

export interface IWatchdogInfo {
  /**
   * Observed process ID.
   */
  pid?: string;

  /**
   * If set to true, this indicates that the process the watchdog is monitoring
   * was not started with the bootloader. In order to debug it, we must tell
   * CDP to force it into debugging mode manually.
   */
  dynamicAttach?: boolean;

  /**
   * Process script name, for cosmetic purposes.
   */
  scriptName: string;

  /**
   * URL of the inspector running on the process.
   */
  inspectorURL: string;

  /**
   * Address on the debugging server to attach to.
   */
  ipcAddress: string;

  /**
   * Whether the process is waiting for the debugger to attach.
   */
  waitForDebugger: boolean;

  /**
   * Parent process ID.
   */
  ppid?: string;
}

export const watchdogPath = join(__dirname, 'watchdog.bundle.js');
export const bootloaderDefaultPath = join(__dirname, 'bootloader.bundle.js');

const enum Method {
  AttachToTarget = 'Target.attachToTarget',
  DetachFromTarget = 'Target.detachFromTarget',
}

export class WatchDog implements IDisposable {
  private readonly onEndEmitter = new EventEmitter<IStopMetadata>();
  private target?: WebSocketTransport;
  private gracefulExit = false;
  private readonly targetInfo: Cdp.Target.TargetInfo = {
    targetId: this.info.pid || '0',
    type: this.info.waitForDebugger ? 'waitingForDebugger' : '',
    title: this.info.scriptName,
    url: 'file://' + this.info.scriptName,
    openerId: this.info.ppid,
    attached: true,
  };

  /**
   * Event that fires when the watchdog stops.
   */
  public readonly onEnd = this.onEndEmitter.event;

  /**
   * Creates a watchdog and returns a promise that resolves once it's attached
   * to the server.
   */
  public static async attach(info: IWatchdogInfo) {
    const pipe: net.Socket = await new Promise((resolve, reject) => {
      const cnx: net.Socket = net.createConnection(info.ipcAddress, () => resolve(cnx));
      cnx.on('error', reject);
    });

    const server = new RawPipeTransport(Logger.null, pipe);
    return new WatchDog(info, server);
  }

  constructor(private readonly info: IWatchdogInfo, private readonly server: ITransport) {
    this.listenToServer();
  }

  /**
   * Attaches listeners to server messages to start passing them to the target.
   * Should be called once when the watchdog is created.
   */
  private listenToServer() {
    const { server, targetInfo } = this;
    server.send(JSON.stringify({ method: 'Target.targetCreated', params: { targetInfo } }));
    server.onMessage(async ([data]) => {
      // Fast-path to check if we might need to parse it:
      if (
        this.target &&
        !data.includes(Method.AttachToTarget) &&
        !data.includes(Method.DetachFromTarget)
      ) {
        this.target.send(data);
        return;
      }

      const result = await this.execute(data);
      if (result) {
        server.send(JSON.stringify(result));
      }
    });

    server.onEnd(() => {
      this.disposeTarget();
      this.onEndEmitter.fire({ killed: this.gracefulExit, code: this.gracefulExit ? 0 : 1 });
    });
  }

  /**
   * @inheritdoc
   */
  public dispose() {
    this.disposeTarget();
    this.server.dispose(); // will cause the end emitter to fire after teardown finishes
  }

  /**
   * Dispatches a method call, invoked with a JSON string and returns a
   * response to return.
   */
  private async execute(data: string): Promise<{} | void> {
    const object = JSON.parse(data);
    switch (object.method) {
      case Method.AttachToTarget:
        if (this.target) {
          this.disposeTarget();
        }
        this.target = await this.createTarget();

        return {
          id: object.id,
          result: {
            sessionId: this.targetInfo.targetId,
            __dynamicAttach: this.info.dynamicAttach ? true : undefined,
          },
        };

      case Method.DetachFromTarget:
        this.gracefulExit = true;
        this.disposeTarget();
        return { id: object.id, result: {} };

      default:
        this.target?.send(object);
        return;
    }
  }

  private async createTarget() {
    this.gracefulExit = false; // reset
    const target = await WebSocketTransport.create(this.info.inspectorURL, NeverCancelled);
    target.onMessage(([data]) => this.server.send(data));
    target.onEnd(() => {
      if (target)
        // Could be due us closing.
        this.server.send(
          JSON.stringify({
            method: 'Target.targetDestroyed',
            params: { targetId: this.targetInfo.targetId, sessionId: this.targetInfo.targetId },
          }),
        );
    });

    return target;
  }

  private disposeTarget() {
    if (this.target) {
      this.target.dispose();
      this.target = undefined;
    }
  }
}

/**
 * Spawns a watchdog attached to the given process.
 */
export function spawnWatchdog(execPath: string, watchdogInfo: IWatchdogInfo) {
  const p = spawn(execPath, [watchdogPath], {
    env: { NODE_INSPECTOR_INFO: JSON.stringify(watchdogInfo) },
    stdio: 'ignore',
    detached: true,
  });
  p.unref();
  process.on('exit', () => p.kill());

  return p;
}
