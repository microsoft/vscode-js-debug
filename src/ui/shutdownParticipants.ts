/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { injectable } from 'inversify';
import { IDisposable, noOpDisposable } from '../common/disposable';

/** Order of shutdown participants. */
export const enum ShutdownOrder {
  // Participant is awaited before loaded scripts are cleared.
  BeforeScripts = 0,
  // Participant is run after everything else.
  Final = 1,
}

export interface IShutdownParticipants {
  /**
   * Registers the function to be called in the specified order.
   */
  register(order: ShutdownOrder, p: () => Promise<void>): IDisposable;

  /**
   * Runs all shutdown participants.
   */
  shutdown(): Promise<void>;
}

export const IShutdownParticipants = Symbol('IShutdownParticipants');

@injectable()
export class ShutdownParticipants implements IShutdownParticipants {
  private participants: Set<() => Promise<void>>[] = [];
  private shutdownStage: ShutdownOrder | undefined;

  register(order: ShutdownOrder, p: () => Promise<void>): IDisposable {
    if (this.shutdownStage !== undefined && this.shutdownStage >= order) {
      p();
      return noOpDisposable;
    }

    while (this.participants.length <= order) {
      this.participants.push(new Set());
    }

    this.participants[order].add(p);
    return { dispose: () => this.participants[order].delete(p) };
  }

  async shutdown(): Promise<void> {
    for (
      this.shutdownStage = 0;
      this.shutdownStage < this.participants.length;
      this.shutdownStage++
    ) {
      await Promise.all([...this.participants[this.shutdownStage]].map(p => p()));
    }
  }
}
