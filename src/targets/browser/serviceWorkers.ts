/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { IDisposable, EventEmitter } from '../../common/events';
import Cdp from '../../cdp/api';
import { FrameModel } from './frames';
import { URL } from 'url';

export class ServiceWorkerRegistration {
  readonly versions = new Map<string, ServiceWorkerVersion>();
  readonly id: string;
  readonly scopeURL: string;
  constructor(payload: Cdp.ServiceWorker.ServiceWorkerRegistration) {
    this.id = payload.registrationId;
    this.scopeURL = payload.scopeURL;
  }
}

export class ServiceWorkerVersion {
  readonly registration: ServiceWorkerRegistration;
  readonly revisions: Cdp.ServiceWorker.ServiceWorkerVersion[] = [];
  readonly id: string;
  readonly scriptURL: string;
  private _targetId: string | undefined;
  private _status: Cdp.ServiceWorker.ServiceWorkerVersionStatus;
  private _runningStatus: Cdp.ServiceWorker.ServiceWorkerVersionRunningStatus;

  constructor(
    registration: ServiceWorkerRegistration,
    payload: Cdp.ServiceWorker.ServiceWorkerVersion,
  ) {
    this.registration = registration;
    this.id = payload.versionId;
    this.scriptURL = payload.scriptURL;
    this._targetId = payload.targetId;
    this._status = payload.status;
    this._runningStatus = payload.runningStatus;
  }

  addRevision(payload: Cdp.ServiceWorker.ServiceWorkerVersion) {
    if (this._targetId && payload.targetId && this._targetId !== payload.targetId)
      console.error(`${this._targetId} !== ${payload.targetId}`);
    if (payload.targetId) this._targetId = payload.targetId;
    this._status = payload.status;
    this._runningStatus = payload.runningStatus;
    this.revisions.unshift(payload);
  }

  status(): Cdp.ServiceWorker.ServiceWorkerVersionStatus {
    return this._status;
  }

  runningStatus(): Cdp.ServiceWorker.ServiceWorkerVersionRunningStatus {
    return this._runningStatus;
  }

  targetId(): string | undefined {
    return this._targetId;
  }

  label(): string {
    const parsedURL = new URL(this.registration.scopeURL);
    let path = parsedURL.pathname.substr(1);
    if (path.endsWith('/')) path = path.substring(0, path.length - 1);
    const scope = path ? path : `${parsedURL.host}`;
    const status = this._status === 'activated' ? '' : ` ${this._status}`;
    const runningStatus = this._runningStatus === 'running' ? '' : ` ${this._runningStatus}`;
    return `${scope} #${this.id}${status}${runningStatus}`;
  }
}

export type ServiceWorkerMode = 'normal' | 'bypass' | 'force';

export class ServiceWorkerModel implements IDisposable {
  private _registrations = new Map<Cdp.ServiceWorker.RegistrationID, ServiceWorkerRegistration>();
  private _versions = new Map<Cdp.Target.TargetID, ServiceWorkerVersion>();
  private _frameModel: FrameModel;
  private _cdp: Cdp.Api | undefined;
  private _onDidChangeUpdater = new EventEmitter<void>();
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

  attached(cdp: Cdp.Api) {
    this._targets.add(cdp);
    if (this._cdp) return;
    // Use first available target connection.
    this._cdp = cdp;
    cdp.ServiceWorker.enable({});
    cdp.ServiceWorker.on('workerRegistrationUpdated', event =>
      this._workerRegistrationsUpdated(event.registrations),
    );
    cdp.ServiceWorker.on('workerVersionUpdated', event =>
      this._workerVersionsUpdated(event.versions),
    );
    if (ServiceWorkerModel._mode !== 'normal') this.setMode(ServiceWorkerModel._mode);
  }

  async detached(cdp: Cdp.Api) {
    this._targets.delete(cdp);
  }

  version(targetId: Cdp.Target.TargetID): ServiceWorkerVersion | undefined {
    return this._versions.get(targetId);
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

  registration(
    registrationId: Cdp.ServiceWorker.RegistrationID,
  ): ServiceWorkerRegistration | undefined {
    return this._registrations.get(registrationId);
  }

  _workerVersionsUpdated(payloads: Cdp.ServiceWorker.ServiceWorkerVersion[]): void {
    for (const payload of payloads) {
      const registration = this._registrations.get(payload.registrationId);
      if (!registration) {
        continue;
      }

      let version = registration.versions.get(payload.versionId);
      if (!version) {
        version = new ServiceWorkerVersion(registration, payload);
        registration.versions.set(payload.versionId, version);
      }
      if (payload.targetId) this._versions.set(payload.targetId, version);
      version.addRevision(payload);
      if (version.status() === 'redundant' && version.runningStatus() === 'stopped') {
        if (payload.targetId) this._versions.delete(payload.targetId);
        registration.versions.delete(version.id);
      }
    }
    this._onDidChangeUpdater.fire();
  }

  _workerRegistrationsUpdated(payloads: Cdp.ServiceWorker.ServiceWorkerRegistration[]): void {
    for (const payload of payloads) {
      if (payload.isDeleted) {
        if (!this._registrations.has(payload.registrationId)) debugger;
        this._registrations.delete(payload.registrationId);
      } else {
        if (this._registrations.has(payload.registrationId)) return;
        this._registrations.set(payload.registrationId, new ServiceWorkerRegistration(payload));
      }
    }
    this._onDidChangeUpdater.fire();
  }

  static setModeForAll(mode: ServiceWorkerMode) {
    ServiceWorkerModel._mode = mode;
    for (const instance of ServiceWorkerModel._instances) instance.setMode(mode);
  }

  setMode(mode: ServiceWorkerMode) {
    if (!this._cdp) return;
    this._cdp.ServiceWorker.setForceUpdateOnPageLoad({ forceUpdateOnPageLoad: mode === 'force' });
    for (const cdp of this._targets.values()) {
      if (mode === 'bypass') {
        cdp.Network.enable({});
        cdp.Network.setBypassServiceWorker({ bypass: true });
      } else {
        cdp.Network.disable({});
      }
    }
  }

  async stopWorker(targetId: Cdp.Target.TargetID) {
    if (!this._cdp) return;
    const version = this.version(targetId);
    if (!version) return;
    await this._cdp.ServiceWorker.stopWorker({
      versionId: version.id,
    });
  }
}
