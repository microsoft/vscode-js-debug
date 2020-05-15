/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { Event } from 'vscode';
import { IDisposable } from '../../common/disposable';
import Dap from '../../dap/api';
import { AnyLaunchConfiguration } from '../../configuration';
import { BasicCpuProfiler } from './basicCpuProfiler';
import { inject, Container, injectable } from 'inversify';
import { IContainer } from '../../ioc-extras';

/**
 * Single profile returned from the IProfiler as a RAII.
 */
export interface IProfile extends IDisposable {
  /**
   * Event that fires to show profile information data to the user.
   */
  readonly onUpdate: Event<string>;

  /**
   * Event that fires when the profiling is stopped for any reason.
   */
  readonly onStop: Event<void>;

  /**
   * Gracefully stops the profiling operation.
   */
  stop(): Promise<void>;
}

export type StartProfileParams<T> = Dap.StartProfileParams & { params?: T };

export interface IProfiler<T> {
  /**
   * Starts capturing a profile.
   */
  start(options: StartProfileParams<T>, file: string): Promise<IProfile>;
}

export interface IProfilerCtor {
  new (...args: never[]): IProfiler<unknown>;

  /**
   * Profiler type given in the DAP API.
   */
  readonly type: string;

  /**
   * Default extension for profiles created from this profiler.
   */
  readonly extension: string;

  /**
   * User-readable profiler name.
   */
  readonly label: string;

  /**
   * Optional user-readable description of the profiler.
   */
  readonly description?: string;

  /**
   * Returns whether this profiler can apply to the given target,
   */
  canApplyTo(options: AnyLaunchConfiguration): boolean;
}

export const IProfilerFactory = Symbol('IProfilerFactory');

export interface IProfilerFactory {
  /**
   * Gets an appropriate profiler for the start params.
   * @throws Error if the type is unrecognized
   */
  get<T>(type: string): IProfiler<T>;
}

/**
 * Simple class that gets profilers
 */
@injectable()
export class ProfilerFactory implements IProfilerFactory {
  public static readonly ctors: ReadonlyArray<IProfilerCtor> = [BasicCpuProfiler];

  constructor(@inject(IContainer) private readonly container: Container) {}

  public get<T>(type: string): IProfiler<T> {
    const ctor = ProfilerFactory.ctors.find(p => p.type === type);
    if (!ctor) {
      throw new Error(`Invalid profilter type ${type}`);
    }

    return this.container.get(ctor);
  }
}
