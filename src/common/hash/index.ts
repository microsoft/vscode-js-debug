/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { ChildProcess, fork } from 'child_process';
import { join } from 'path';
import { IDisposable } from '../disposable';
import { debounce } from '../objUtils';
import { getDeferred, IDeferred } from '../promiseUtil';
import { HashRequest, HashResponse, MessageType } from './hash';

export class Hasher implements IDisposable {
  private idCounter = 0;
  private instance: ChildProcess | undefined;
  private failureCount = 0;
  private readonly deferredMap = new Map<
    number,
    { deferred: IDeferred<HashResponse<HashRequest>>; request: {} }
  >();

  private readonly deferCleanup = debounce(30_000, () => this.cleanup());

  constructor(private readonly maxFailures = 3) {}

  /**
   * Gets the Chrome content hash of script contents.
   */
  public async hashBytes(data: string | Buffer) {
    const r = await this.send({ type: MessageType.HashBytes, data, id: this.idCounter++ });
    return r.hash;
  }
  /**
   * Gets the Chrome content hash of a file.
   */
  public async hashFile(file: string) {
    const r = await this.send({ type: MessageType.HashFile, file, id: this.idCounter++ });
    return r.hash;
  }
  /**
   * Gets the Chrome content hash of script contents.
   */
  public async verifyBytes(data: string | Buffer, expected: string, checkNode: boolean) {
    const r = await this.send({
      type: MessageType.VerifyBytes,
      data,
      id: this.idCounter++,
      expected,
      checkNode,
    });
    return r.matches;
  }

  /**
   * Gets the Chrome content hash of a file.
   */
  public async verifyFile(file: string, expected: string, checkNode: boolean) {
    const r = await this.send({
      type: MessageType.VerifyFile,
      file,
      id: this.idCounter++,
      expected,
      checkNode,
    });
    return r.matches;
  }

  /**
   * @inheritdoc
   */
  public dispose() {
    this.cleanup();
    this.deferCleanup.clear();
  }

  private send<T extends HashRequest>(req: T): Promise<HashResponse<T>> {
    const cp = this.getProcess();
    if (!cp) {
      throw new Error('hash.bundle.js process unexpectedly exited');
    }

    this.deferCleanup();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const deferred = getDeferred<any>();
    this.deferredMap.set(req.id, { deferred, request: req });
    cp.send(req);

    return deferred.promise;
  }

  private cleanup() {
    if (this.instance) {
      this.instance.removeAllListeners('exit');
      this.instance.kill();
      this.instance = undefined;
      this.failureCount = 0;
    }
  }

  private getProcess() {
    if (this.instance) {
      return this.instance;
    }

    if (this.failureCount > this.maxFailures) {
      return undefined;
    }

    const instance = (this.instance = fork(join(__dirname, 'hash.bundle.js'), [], {
      env: {},
      silent: true,
      execArgv: [],
    }));

    instance.setMaxListeners(Infinity);
    instance.addListener('message', raw => {
      const msg = raw as HashResponse<HashRequest>;
      const pending = this.deferredMap.get(msg.id);
      if (!pending) {
        return;
      }

      pending.deferred.resolve(msg);
      this.deferredMap.delete(msg.id);
    });

    instance.on('exit', () => {
      this.instance = undefined;

      if (this.failureCount++ >= this.maxFailures) {
        for (const { deferred } of this.deferredMap.values()) {
          deferred.reject(new Error('hash.bundle.js process unexpectedly exited'));
        }
        this.deferredMap.clear();
        this.deferCleanup.clear();
      } else {
        const newInstance = this.getProcess();
        this.deferCleanup();

        for (const { request } of this.deferredMap.values()) {
          newInstance?.send(request);
        }
      }
    });

    return instance;
  }
}
