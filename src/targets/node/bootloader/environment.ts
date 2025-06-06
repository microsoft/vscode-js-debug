/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { AutoAttachMode } from '../../../common/contributionUtils';
import type { IProcessTelemetry } from '../nodeLauncherBase';
import type { IWatchdogInfo } from '../watchdogSpawn';

/**
 * Attachment mode for the debugger.
 *
 *  - Synchronous -- the process will attach to the NODE_INSPECTOR_IPC pipe
 *    immediately when the process launches.
 *  - Asnychonrous -- the process will add its inspect URL to the
 *    NODE_INSPECTOR_IPC file when it launches and will not wait for the
 *    debugger to attach
 *
 * Asynchonrous mode is used for the passive terminal environment variables
 */
export const enum BootloaderAttachMode {
  Synchronous = 'sync',
  Asynchronous = 'async',
}

export interface IBootloaderInfo {
  /**
   * Opener target ID this should be assigned to.
   */
  openerId?: string;

  /**
   * Address of the debugger pipe server.
   */
  inspectorIpc: string;

  /**
   * If given, watchdog info will be written to the NODE_INSPECTOR_IPC rather
   * than it being used.
   */
  deferredMode?: boolean;

  /**
   * If present, requires the given file to exist on disk to enter debug mode.
   */
  requireLease?: string;

  /**
   * Executable path that spawned the first process. Used to run the watchdog
   * under the same Node environment in the event children get spawned as
   * electron or other exotic things.
   */
  execPath?: string;

  /**
   * Regex that can be used to match and determine whether the process should
   * be debugged based on its script name.
   */
  waitForDebugger?: string;

  /**
   * If present, add process telemetry to the given file.
   */
  fileCallback?: string;

  /**
   * Whether only the entrypoint should be debugged.
   */
  onlyEntrypoint: boolean;

  /**
   * Auto attach mode, see the descriptions in strings.ts for info.
   */
  autoAttachMode: AutoAttachMode;

  /**
   * Pattern globs to use when auto attaching in 'smart' mode.
   */
  aaPatterns?: ReadonlyArray<string>;

  /**
   * Whether the process is running in a remote environment.
   */
  mandatePortTracking?: boolean;

  /**
   * Whether to log verbosely.
   */
  verbose?: boolean;
}

export interface IBootloaderEnvironment {
  /**
   * (Originally json-encoded) options for the inspector
   */
  VSCODE_INSPECTOR_OPTIONS: string;

  /**
   * NODE_OPTIONS, standard variable read by Node.js which --require's this
   * bootloader.
   */
  NODE_OPTIONS: string;
}

/**
 * JSON given to the auto attach parent. The parent uses this to start a
 * watchdog for the child.
 */
export interface IAutoAttachInfo extends IWatchdogInfo {
  telemetry: IProcessTelemetry;
}

export const variableDelimiter = ':::';

export class BootloaderEnvironment {
  constructor(private readonly processEnv: NodeJS.ProcessEnv) {}

  public get nodeOptions() {
    return this.processEnv.NODE_OPTIONS;
  }

  public set nodeOptions(value: string | undefined) {
    if (value === undefined) {
      delete this.processEnv.NODE_OPTIONS;
    } else {
      this.processEnv.NODE_OPTIONS = value;
    }
  }

  public get inspectorOptions() {
    const value = this.processEnv.VSCODE_INSPECTOR_OPTIONS;
    if (!value) {
      return undefined;
    }

    const ownOptions = value.split(variableDelimiter).reverse().find(v => !!v);
    if (!ownOptions) {
      return;
    }

    try {
      return JSON.parse(ownOptions) as Readonly<IBootloaderInfo>;
    } catch {
      return undefined;
    }
  }

  public set inspectorOptions(value: IBootloaderInfo | undefined) {
    if (value === undefined) {
      delete this.processEnv.VSCODE_INSPECTOR_OPTIONS;
    } else {
      this.processEnv.VSCODE_INSPECTOR_OPTIONS = JSON.stringify(value);
    }
  }

  /**
   * Unsets inspector options for this and all child processes.
   */
  public unsetForTree() {
    delete this.processEnv.VSCODE_INSPECTOR_OPTIONS;
  }

  /**
   * Updates a single inspector option key/value.
   */
  public updateInspectorOption<K extends keyof IBootloaderInfo>(
    key: K,
    value: IBootloaderInfo[K],
  ) {
    const options = this.inspectorOptions;
    if (options) {
      this.inspectorOptions = { ...options, [key]: value };
    }
  }
}
