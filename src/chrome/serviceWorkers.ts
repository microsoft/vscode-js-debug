/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import Cdp from '../cdp/api';
import { FrameModel } from './frames';

export class ServiceWorkerRegistration {
  readonly versions = new Map<string, ServiceWorkerVersion>();
  readonly id: string;
  readonly scopeURL: string;
  constructor(payload: Cdp.ServiceWorker.ServiceWorkerRegistration) {
    this.id = payload.registrationId;
    this.scopeURL = payload.scopeURL;
  }
}

export class ServiceWorkerVersion  {
  readonly registration: ServiceWorkerRegistration;
  readonly revisions: Cdp.ServiceWorker.ServiceWorkerVersion[] = [];
  readonly id: string;
  readonly scriptURL: string;
  private targetId_: string | undefined;

  constructor(registration: ServiceWorkerRegistration, payload: Cdp.ServiceWorker.ServiceWorkerVersion) {
    this.registration = registration;
    this.id = payload.versionId;
    this.scriptURL = payload.scriptURL;
    this.targetId_ = payload.targetId;
  }

  addRevision(payload: Cdp.ServiceWorker.ServiceWorkerVersion) {
    if (this.targetId_ && payload.targetId && this.targetId_ !== payload.targetId)
      console.error(`${this.targetId_} !== ${payload.targetId}`);
    if (payload.targetId)
      this.targetId_ = payload.targetId;
    this.revisions.unshift(payload);
  }

  targetId(): string | undefined {
    return this.targetId_;
  }

  runningStatus(): string {
    if (this.revisions[0].runningStatus === 'running' || this.revisions[0].runningStatus === 'starting')
      return '🏃';
    return '🏁';
  }

  label(): string {
    const scriptURL = this.scriptURL.substring(this.registration.scopeURL.length);
    return `${scriptURL} #${this.id}`;
  }

  labelWithStatus(): string {
    return `${this.runningStatus()}${this.label()} (${this.revisions[0].status})`;
  }
}

export type ServiceWorkerMode = 'normal' | 'bypass' | 'force';

export class ServiceWorkerModel implements vscode.Disposable {
  private _registrations = new Map<Cdp.ServiceWorker.RegistrationID, ServiceWorkerRegistration>();
  private _versions = new Map<Cdp.Target.TargetID, ServiceWorkerVersion>();
  private _frameModel: FrameModel;
  private _cdp: Cdp.Api;
  private _onDidChangeUpdater = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChangeUpdater.event;
  private _targets = new Set<Cdp.Api>();
  private static _mode: ServiceWorkerMode;
  private static _instances = new Set<ServiceWorkerModel>();

  constructor(frameModel: FrameModel) {
    this._frameModel = frameModel;
    ServiceWorkerModel._instances.add(this);
  }

  dispose() {
    ServiceWorkerModel._instances.delete(this);
  }

  async addTarget(cdp: Cdp.Api) {
    this._targets.add(cdp);
    if (this._cdp)
      return;
    // Use first available target connection.
    this._cdp = cdp;
    await cdp.ServiceWorker.enable({});
    cdp.ServiceWorker.on('workerRegistrationUpdated', event => this._workerRegistrationsUpdated(event.registrations));
    cdp.ServiceWorker.on('workerVersionUpdated', event => this._workerVersionsUpdated(event.versions));
    if (ServiceWorkerModel._mode !== 'normal')
      await this.setMode(ServiceWorkerModel._mode);
  }

  async removeTarget(cdp: Cdp.Api) {
    this._targets.delete(cdp);
  }

  version(targetId: Cdp.Target.TargetID): ServiceWorkerVersion | undefined {
    return this._versions.get(targetId);
  }

  versionStatus(targetId: Cdp.Target.TargetID): string | undefined {
    const version = this._versions.get(targetId);
    return version ? version.revisions[0].status : undefined;
  }

  registrations(): ServiceWorkerRegistration[] {
    const result: ServiceWorkerRegistration[] = [];
    const urls = this._frameModel.frames().map(frame => frame.url());
    for (const registration of this._registrations.values()) {
      for (const url of urls) {
        if (url.startsWith(registration.scopeURL)) {
          result.push(registration);
          break;
        }
      }
    }
    return result;
  }

  registration(registrationId: Cdp.ServiceWorker.RegistrationID): ServiceWorkerRegistration | undefined {
    return this._registrations.get(registrationId);
  }

  _workerVersionsUpdated(payloads: Cdp.ServiceWorker.ServiceWorkerVersion[]): void {
    for (const payload of payloads) {
      const registration = this._registrations.get(payload.registrationId)!;
      let version = registration.versions.get(payload.versionId);
      if (!version) {
        version = new ServiceWorkerVersion(registration, payload);
        registration.versions.set(payload.versionId, version);
      }
      if (payload.targetId)
        this._versions.set(payload.targetId, version);
      version.addRevision(payload);
      // TODO: display redundant version as tombstones.
    }
    this._onDidChangeUpdater.fire();
  }

  _workerRegistrationsUpdated(payloads: Cdp.ServiceWorker.ServiceWorkerRegistration[]): void {
    for (const payload of payloads) {
      if (payload.isDeleted) {
        if (!this._registrations.has(payload.registrationId)) debugger;
        this._registrations.delete(payload.registrationId);
      } else {
        if (this._registrations.has(payload.registrationId))
          return;
        this._registrations.set(payload.registrationId, new ServiceWorkerRegistration(payload));
      }
    }
    this._onDidChangeUpdater.fire();
  }

  static setModeForAll(mode: ServiceWorkerMode) {
    ServiceWorkerModel._mode = mode;
    for (const instance of ServiceWorkerModel._instances)
      instance.setMode(mode);
  }

  async setMode(mode: ServiceWorkerMode) {
    if (!this._cdp)
        return;
    this._cdp.ServiceWorker.setForceUpdateOnPageLoad({ forceUpdateOnPageLoad: mode === 'force' });
    for (const cdp of this._targets.values()) {
      if (mode === 'bypass') {
        await cdp.Network.enable({});
        await cdp.Network.setBypassServiceWorker({ bypass: true });
      } else {
        await cdp.Network.disable({});
      }
    }
  }
}
