/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { Container, inject, injectable } from 'inversify';
import { Event } from 'vscode';
import { IDisposable } from '../../common/disposable';
import { AnyLaunchConfiguration } from '../../configuration';
import Dap from '../../dap/api';
import { IContainer } from '../../ioc-extras';
import { BasicCpuProfiler } from './basicCpuProfiler';
import { BasicHeapProfiler } from './basicHeapProfiler';
import { HeapDumpProfiler } from './heapDumpProfiler';

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
  new(...args: never[]): IProfiler<unknown>;

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
   * Whether the profiler captures an instant snapshot versus sampling for a
   * duration. Defaults to false.
   */
  readonly instant?: boolean;

  /**
   * Whether the resulting file can be edited in VS Code. Defaults to false.
   */
  readonly editable?: boolean;

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
 * Gets a default profile file name (without an extension)
 */
export const getDefaultProfileName = () => {
  const now = new Date();
  return [
    'vscode-profile',
    now.getFullYear(),
    now.getMonth() + 1,
    now.getDate(),
    now.getHours(),
    now.getMinutes(),
    now.getSeconds(),
  ]
    .map(n => String(n).padStart(2, '0'))
    .join('-');
};

/**
 * Simple class that gets profilers
 */
@injectable()
export class ProfilerFactory implements IProfilerFactory {
  public static readonly ctors: ReadonlyArray<IProfilerCtor> = [
    BasicCpuProfiler,
    BasicHeapProfiler,
    HeapDumpProfiler,
  ];

  constructor(@inject(IContainer) private readonly container: Container) {}

  public get<T>(type: string): IProfiler<T> {
    const ctor = ProfilerFactory.ctors.find(p => p.type === type);
    if (!ctor) {
      throw new Error(`Invalid profilter type ${type}`);
    }

    return this.container.get(ctor);
  }
}
