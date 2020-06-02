/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { ITarget } from '../targets';
import { ObservableMap } from '../../common/datastructure/observableMap';
import { IDelegateRef, DelegateLauncher } from './delegateLauncher';
import { IPendingDapApi } from '../../dap/pending-api';
import { injectable } from 'inversify';
import { ILogger } from '../../common/logging';

let idCounter = 0;

/**
 * An extension-global instance used to shuffle delegated launch sessions.
 * See docblocks on {@link DelegateLauncher} for usage details.
 */
@injectable()
export class DelegateLauncherFactory {
  private delegateSessions = new ObservableMap<number, IDelegateRef>();
  private refsByTarget = new WeakMap<ITarget, IDelegateRef>();

  /**
   * Returns a new launcher that references this delegate sessions.
   */
  public createLauncher(logger: ILogger) {
    return new DelegateLauncher(this.delegateSessions, logger);
  }

  /**
   * Adds a new delegate target, returning the ID of the created delegate.
   */
  public addDelegate(target: ITarget, dap: IPendingDapApi, parent?: ITarget): number {
    const ref = { id: idCounter++, target, dap, parent: parent && this.refsByTarget.get(parent) };
    this.refsByTarget.set(target, ref);
    this.delegateSessions.add(ref.id, ref);
    return ref.id;
  }

  /**
   * Removes a delegate target, returning the ID of the destroyed delegate.
   */
  public removeDelegate(target: ITarget) {
    const ref = this.refsByTarget.get(target);
    if (ref) {
      this.delegateSessions.remove(ref.id);
    }
  }
}
