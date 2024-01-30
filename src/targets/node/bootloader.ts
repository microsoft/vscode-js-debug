/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as inspector from 'inspector';
import match from 'micromatch';
import * as path from 'path';
import { AutoAttachMode } from '../../common/contributionUtils';
import { findOpenPortSync } from '../../common/findOpenPortSync';
import { knownToolGlob, knownToolToken } from '../../common/knownTools';
import { LogTag } from '../../common/logging';
import { BootloaderEnvironment, IAutoAttachInfo, IBootloaderInfo } from './bootloader/environment';
import { checkAll } from './bootloader/filters';
import { bootloaderLogger } from './bootloader/logger';
import { watchdogPath } from './bundlePaths';
import { createTargetId } from './createTargetId';
import { IProcessTelemetry } from './nodeLauncherBase';
import { IWatchdogInfo } from './watchdogSpawn';

const telemetry: IProcessTelemetry = {
  cwd: process.cwd(),
  processId: process.pid,
  nodeVersion: process.version,
  architecture: process.arch,
};

const jsDebugRegisteredToken = '$jsDebugIsRegistered';

(() => {
  try {
    if (jsDebugRegisteredToken in global) {
      return;
    }

    const env = new BootloaderEnvironment(process.env);
    const inspectorOptions = env.inspectorOptions;
    bootloaderLogger.enabled = !!inspectorOptions?.verbose;
    bootloaderLogger.info(LogTag.RuntimeLaunch, 'Bootloader imported', {
      env: inspectorOptions,
      args: process.argv,
    });

    // not enumerable to not get picked up by node's testing globals leakage checks
    Object.defineProperty(global, jsDebugRegisteredToken, {
      value: true,
      enumerable: false,
    });

    if (!checkAll(inspectorOptions)) {
      env.unsetForTree(); // save work for any children
      return;
    }

    try {
      if (!require('worker_threads').isMainThread) {
        return;
      }
    } catch {
      // ignored, old node version without worker threads
    }

    reportTelemetry(env);

    if (/(\\|\/|^)node(64)?(.exe)?$/.test(process.execPath)) {
      inspectorOptions.execPath = process.execPath;
    }

    const ownId = createTargetId();
    const didAttach = inspectOrQueue(inspectorOptions, ownId);
    if (inspectorOptions.onlyEntrypoint) {
      env.unsetForTree();
    } else if (didAttach) {
      env.updateInspectorOption('openerId', ownId);
    }
  } catch (e) {
    console.error(
      `Error in the js-debug bootloader, please report to https://aka.ms/js-dbg-issue: ${
        e.stack || e.message || e
      }`,
    );
  }
})();

const enum Mode {
  Immediate,
  Deferred,
  Inactive,
}

function inspectOrQueue(env: IBootloaderInfo, ownId: string): boolean {
  const mode = !isPipeAvailable(env.inspectorIpc)
    ? Mode.Inactive
    : env.deferredMode
    ? Mode.Deferred
    : Mode.Immediate;

  bootloaderLogger.info(LogTag.Runtime, 'Set debug mode', { mode });
  if (mode === Mode.Inactive) {
    return false;
  }

  // inspector.url() will be defined if --inspect is passed to the process.
  // Don't call it again to avoid https://github.com/nodejs/node/issues/33012
  const openedFromCli = inspector.url() !== undefined;
  if (!openedFromCli) {
    // if the debugger isn't explicitly enabled, turn it on based on our inspect mode
    if (!shouldForceProcessIntoDebugMode(env)) {
      return false;
    }

    inspector.open(getInspectPort(env), undefined, false); // first call to set the inspector.url()
  }

  const info: IAutoAttachInfo = {
    ipcAddress: env.inspectorIpc || '',
    pid: String(process.pid),
    telemetry,
    scriptName: process.argv[1],
    inspectorURL: inspector.url() as string,
    waitForDebugger: true,
    ownId,
    openerId: env.openerId,
  };

  if (mode === Mode.Immediate) {
    spawnWatchdog(env.execPath || process.execPath, info);
  } else {
    // The bootloader must call inspector.open() synchronously, which will block
    // the event loop. Spawn the watchdog handoff in a new process to debug this.

    /*
    // Minified code is given in spawnSync:

    const c: Socket = require('net').createConnection(process.env.NODE_INSPECTOR_IPC);
    setTimeout(() => {
      console.error('timeout');
      process.exit(1);
    }, 10000);
    c.on('error', err => {
      console.error(err);
      process.exit(1);
    });
    c.on('connect', () => {
      c.write(process.env.NODE_INSPECTOR_INFO, 'utf-8');
      c.write(Buffer.from([0]));
      c.on('data', c => {
        console.error('read byte', c[0]);
        process.exit(c[0]);
      });
    });
    */

    const { status, stderr } = spawnSync(
      env.execPath || process.execPath,
      [
        '-e',
        `const c=require("net").createConnection(process.env.NODE_INSPECTOR_IPC);setTimeout(()=>{console.error("timeout"),process.exit(1)},10000),c.on("error",e=>{console.error(e),process.exit(1)}),c.on("connect",()=>{c.write(process.env.NODE_INSPECTOR_INFO,"utf-8"),c.write(Buffer.from([0])),c.on("data",e=>{console.error("read byte",e[0]),process.exit(e[0])})});`,
      ],
      {
        env: {
          NODE_SKIP_PLATFORM_CHECK: process.env.NODE_SKIP_PLATFORM_CHECK,
          NODE_INSPECTOR_INFO: JSON.stringify(info),
          NODE_INSPECTOR_IPC: env.inspectorIpc,
          ELECTRON_RUN_AS_NODE: '1',
        },
      },
    );

    if (status) {
      console.error(stderr.toString());
      console.error(`Error activating auto attach, please report to https://aka.ms/js-dbg-issue`);
      return false; // some error status code
    }
  }

  // todo: update node.js typings
  const cast = inspector as unknown as typeof inspector & { waitForDebugger?(): void };
  if (cast.waitForDebugger) {
    cast.waitForDebugger();
  } else {
    inspector.open(openedFromCli ? undefined : 0, undefined, true);
  }

  return true;
}

/**
 * Returns the port that the inspector should listen on.
 */
function getInspectPort(env: IBootloaderInfo) {
  // Port checking is a little slow (especially on windows), avoid doing
  // so if port registration is not mandatory
  if (!env.mandatePortTracking) {
    return 0;
  }

  try {
    return findOpenPortSync({ attempts: 20 });
  } catch {
    return 0;
  }
}

function shouldForceProcessIntoDebugMode(env: IBootloaderInfo) {
  switch (env.autoAttachMode) {
    case AutoAttachMode.Always:
      return true;
    case AutoAttachMode.Smart:
      return shouldSmartAttach(env);
    case AutoAttachMode.OnlyWithFlag:
    default:
      return false;
  }
}

/**
 * Returns whether to smart attach. The goal here is to avoid attaching to
 * scripts like `npm` or `webpack` which the user probably doesn't want to
 * debug. Unfortunately Node doesn't expose the originally argv to us where
 * we could detect a direct invokation of something like `npm install`,
 * so we match against the script name.
 */
function shouldSmartAttach(env: IBootloaderInfo) {
  const script: string | undefined = process.argv[1];
  if (!script) {
    return true; // node REPL
  }

  // otherwise, delegate to the patterns. Defaults exclude node_modules
  return autoAttachSmartPatternMatches(script, env);
}

function autoAttachSmartPatternMatches(script: string, env: IBootloaderInfo) {
  if (!env.aaPatterns) {
    return false;
  }

  const r = match(
    [script.replace(/\\/g, '/')],
    [...env.aaPatterns.map(p => p.replace(knownToolToken, knownToolGlob))],
    { dot: true, nocase: true },
  );

  return r.length > 0;
}

function isPipeAvailable(pipe?: string): pipe is string {
  if (!pipe) {
    return false;
  }

  try {
    // normally we'd use l/stat, but doing so with pipes on windows actually
    // triggers a 'connection', so do this instead...
    return fs.readdirSync(path.dirname(pipe)).includes(path.basename(pipe));
  } catch (e) {
    return false;
  }
}

/**
 * Adds process telemetry to the debugger file if necessary.
 */
function reportTelemetry(env: BootloaderEnvironment) {
  const callbackFile = env.inspectorOptions?.fileCallback;
  if (!callbackFile) {
    return;
  }

  try {
    fs.writeFileSync(callbackFile, JSON.stringify(telemetry));
  } catch {
    // ignored, #1797, debug could have torn down
  }

  env.updateInspectorOption('fileCallback', undefined);
}

/**
 * Spawns a watchdog attached to the given process.
 */
function spawnWatchdog(execPath: string, watchdogInfo: IWatchdogInfo) {
  const p = spawn(execPath, [watchdogPath], {
    env: {
      NODE_INSPECTOR_INFO: JSON.stringify(watchdogInfo),
      NODE_SKIP_PLATFORM_CHECK: process.env.NODE_SKIP_PLATFORM_CHECK,
      ELECTRON_RUN_AS_NODE: '1',
    },
    stdio: 'ignore',
    detached: true,
  });
  p.unref();

  return p;
}
