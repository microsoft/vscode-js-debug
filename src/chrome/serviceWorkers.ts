// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import Cdp from '../cdp/api';

export class ServiceWorkerModel {
  private _versions: Cdp.ServiceWorker.ServiceWorkerVersion[];
  private _statuses = new Map<Cdp.Target.TargetID, Cdp.ServiceWorker.ServiceWorkerVersionStatus>();
  private _cdp: Cdp.Api;
  private _refreshCallback: () => void;

  constructor(callback: () => void) {
    this._refreshCallback = callback;
  }

  async addTarget(cdp: Cdp.Api) {
    if (this._cdp)
      return;
    // Use first available target connection.
    await cdp.ServiceWorker.enable({});
    cdp.ServiceWorker.on('workerVersionUpdated', event => this._workerVersionUpdated(event.versions));
    this._cdp = cdp;
  }

  versionStatus(targetId: Cdp.Target.TargetID): string | undefined {
    return this._statuses.get(targetId);
  }

  _workerVersionUpdated(versions: Cdp.ServiceWorker.ServiceWorkerVersion[]): void {
    this._statuses.clear();
    this._versions = versions;
    for (const version of this._versions) {
      if (version.targetId)
        this._statuses.set(version.targetId, version.status);
    }
    this._refreshCallback();
  }
}
