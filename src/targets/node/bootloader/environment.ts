/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

export interface IBootloaderEnvironment {
  /**
   * Parent process ID that spawned this one. Can be:
   *  - an empty string -- indicating we're the parent process
   *  - 0 -- indicating there's some parent (e.g. attach) that we shouldn't track/kill
   *  - a string-encoded number
   */
  NODE_INSPECTOR_PPID: string;

  /**
   * Address of the debugger pipe server.
   */
  NODE_INSPECTOR_IPC: string;

  /**
   * If present, requires the given file to exist on disk to enter debug mode.
   */
  NODE_INSPECTOR_REQUIRE_LEASE?: string;

  /**
   * NODE_OPTIONS, standard variable read by Node.js which --require's this
   * bootloader.
   */
  NODE_OPTIONS: string;

  /**
   * Executable path that spawned the first process. Used to run the watchdog
   * under the same Node environment in the event children get spawned as
   * electron or other exotic things.
   */
  NODE_INSPECTOR_EXEC_PATH?: string;

  /**
   * Regex that can be used to match and determine whether the process should
   * be debugged based on its script name.
   */
  NODE_INSPECTOR_WAIT_FOR_DEBUGGER?: string;

  /**
   * If present, add process telemetry to the given file.
   */
  VSCODE_DEBUGGER_FILE_CALLBACK: string;

  /**
   * Whether only the entrypoint should be debugged.
   */
  VSCODE_DEBUGGER_ONLY_ENTRYPOINT: 'true' | 'false';
}

const processEnv = (process.env as unknown) as IBootloaderEnvironment;

export const bootloaderEnv: Partial<IBootloaderEnvironment> = new Proxy(
  {
    NODE_INSPECTOR_PPID: processEnv.NODE_INSPECTOR_PPID,
    NODE_INSPECTOR_IPC: processEnv.NODE_INSPECTOR_IPC,
    NODE_INSPECTOR_REQUIRE_LEASE: processEnv.NODE_INSPECTOR_REQUIRE_LEASE,
    NODE_OPTIONS: processEnv.NODE_OPTIONS,
    VSCODE_DEBUGGER_FILE_CALLBACK: processEnv.VSCODE_DEBUGGER_FILE_CALLBACK,
    VSCODE_DEBUGGER_ONLY_ENTRYPOINT: processEnv.VSCODE_DEBUGGER_ONLY_ENTRYPOINT,
    NODE_INSPECTOR_EXEC_PATH: processEnv.NODE_INSPECTOR_EXEC_PATH,
  },
  {
    set<K extends keyof IBootloaderEnvironment>(
      target: IBootloaderEnvironment,
      key: K,
      value: IBootloaderEnvironment[K],
    ) {
      target[key] = value;

      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }

      return true;
    },
  },
);
