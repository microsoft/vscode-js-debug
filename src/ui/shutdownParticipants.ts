/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { injectable } from 'inversify';
import { IDisposable, noOpDisposable } from '../common/disposable';

/** Order of shutdown participants. */
export const enum ShutdownOrder {
  // Participant is awaited before loaded scripts are cleared in an execution context.
  ExecutionContexts = 0,
  // Participant is run after everything else.
  Final = 1,
}

export interface IShutdownParticipants {
  /**
   * Registers the function to be called in the specified order.
   *
   * A participant that happens on ExecutionContexts may be called multiple
   * times of the course of the application's lifetime.
   */
  register(order: ShutdownOrder, p: (isFinal: boolean) => Promise<void>): IDisposable;

  /**
   * Runs shutdown participants that trigger when an execution context is cleared.
   */
  shutdownContext(): Promise<void>;

  /**
   * Runs all shutdown participants.
   */
  shutdownAll(): Promise<void>;
}

export const IShutdownParticipants = Symbol('IShutdownParticipants');

@injectable()
export class ShutdownParticipants implements IShutdownParticipants {
  private participants: Set<(isFinal: boolean) => Promise<void>>[] = [];
  private shutdownStage: ShutdownOrder | undefined;

  register(order: ShutdownOrder, p: (isFinal: boolean) => Promise<void>): IDisposable {
    if (this.shutdownStage !== undefined && this.shutdownStage >= order) {
      p(true);
      return noOpDisposable;
    }

    while (this.participants.length <= order) {
      this.participants.push(new Set());
    }

    this.participants[order].add(p);
    return { dispose: () => this.participants[order].delete(p) };
  }

  async shutdownContext(): Promise<void> {
    if (this.shutdownStage === undefined || this.shutdownStage < ShutdownOrder.ExecutionContexts) {
      await Promise.all(
        [...this.participants[ShutdownOrder.ExecutionContexts]].map(p => p(false)),
      );
    }
  }

  async shutdownAll(): Promise<void> {
    for (
      this.shutdownStage = 0;
      this.shutdownStage < this.participants.length;
      this.shutdownStage++
    ) {
      await Promise.all([...this.participants[this.shutdownStage]].map(p => p(true)));
    }
  }
}
