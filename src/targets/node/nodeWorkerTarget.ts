/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import Cdp from '../../cdp/api';
import { EventEmitter } from '../../common/events';
import { ILogger } from '../../common/logging';
import { absolutePathToFileUrl } from '../../common/urlUtils';
import { AnyLaunchConfiguration } from '../../configuration';
import { ITargetOrigin } from '../targetOrigin';
import { ITarget } from '../targets';
import { NodeTarget } from './nodeTarget';

export class NodeWorkerTarget implements ITarget {
  public readonly onNameChanged = new EventEmitter<void>().event;
  private attached = false;
  private isWaitingForDebugger = true;

  constructor(
    public readonly launchConfig: AnyLaunchConfiguration,
    public readonly targetInfo: Cdp.Target.TargetInfo,
    private readonly parentTarget: NodeTarget,
    private readonly targetOriginValue: ITargetOrigin,
    private readonly cdp: Cdp.Api,
    public readonly logger: ILogger,
  ) {
    cdp.pause();
  }

  id(): string {
    return this.targetInfo.targetId;
  }

  name(): string {
    return this.targetInfo.title;
  }

  fileName(): string | undefined {
    return this.targetInfo.url;
  }

  type(): string {
    return 'node';
  }

  parent(): ITarget | undefined {
    return this.parentTarget;
  }

  children(): ITarget[] {
    return [];
  }

  canStop(): boolean {
    return false;
  }

  stop(): void {
    // no-op
  }

  canRestart(): boolean {
    return false;
  }
  restart(): void {
    // no-op
  }

  canAttach(): boolean {
    return !this.attached;
  }

  public async attach(): Promise<Cdp.Api | undefined> {
    // order matters! The runtime must be enabled first so we know what
    // execution contexts scripts are in
    await this.cdp.Runtime.enable({});
    if (!this.launchConfig.noDebug) {
      await this.cdp.Debugger.enable({});
    }
    this.attached = true;
    return this.cdp;
  }

  public canDetach(): boolean {
    return this.attached;
  }

  public async detach(): Promise<void> {
    // there seems to be a bug where if we detach while paused, the worker will remain paused
    await this.cdp.Debugger.resume({});
    await this.cdp.NodeWorker.detach({ sessionId: this.targetInfo.targetId });
    this.attached = false;
  }

  public targetOrigin(): ITargetOrigin {
    return this.targetOriginValue;
  }

  public afterBind(): Promise<void> {
    this.cdp.resume();
    return Promise.resolve();
  }

  public async runIfWaitingForDebugger(): Promise<void> {
    this.isWaitingForDebugger = false;
    await this.cdp.Runtime.runIfWaitingForDebugger({});
  }

  public initialize(): Promise<void> {
    return Promise.resolve();
  }

  public waitingForDebugger(): boolean {
    return this.isWaitingForDebugger;
  }

  supportsCustomBreakpoints(): boolean {
    return false;
  }

  supportsXHRBreakpoints(): boolean {
    return false;
  }

  scriptUrlToUrl(url: string): string {
    // copied from NodeTarget. Todo: should be merged into the path resolver logic
    const isPath = url[0] === '/'
      || (process.platform === 'win32' && url[1] === ':' && url[2] === '\\');
    return isPath ? absolutePathToFileUrl(url) : url;
  }

  executionContextName(): string {
    return this.targetInfo.title;
  }
}
