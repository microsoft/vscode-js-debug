/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import Dap from '../dap/api';
import {CdpApi} from '../cdp/api';
import {SourceContainer} from './source';
import {TargetManager} from './targetManager';
import {VariableStore} from './variableStore';
import {Thread} from './thread';
import CdpConnection from '../cdp/connection';

export interface LaunchParams extends Dap.LaunchParams {
  url: string;
  webRoot?: string;
}

export class Context {
  public dap: Dap.Api;
  public browser: CdpApi;
  public sourceContainer: SourceContainer;
  public targetManager: TargetManager;
  public launchParams: LaunchParams;
  public threads: Map<number, Thread>;
  public variableStore: VariableStore;

  constructor(dap: Dap.Api, connection: CdpConnection) {
    this.dap = dap;
    this.sourceContainer = new SourceContainer(this);
    this.variableStore = new VariableStore(this);
    this.targetManager = new TargetManager(connection, this);
    this.browser = connection.browser();
    this.threads = new Map();
    this.launchParams = {url: ''};
  }

  initialize(launchParams: LaunchParams) {
    this.launchParams = launchParams;
    this.sourceContainer.initialize();
  }

  initialized(): boolean {
    return !!this.launchParams;
  }
};
