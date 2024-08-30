/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { Container } from 'inversify';
import * as os from 'os';
import { CancellationToken } from 'vscode';
import { getAsyncStackPolicy, IAsyncStackPolicy } from './adapter/asyncStackPolicy';
import { DebugAdapter } from './adapter/debugAdapter';
import { DiagnosticToolSuggester } from './adapter/diagnosticToolSuggester';
import { SelfProfile } from './adapter/selfProfile';
import { Thread } from './adapter/threads';
import Cdp from './cdp/api';
import { CancellationTokenSource } from './common/cancellation';
import { DisposableList } from './common/disposable';
import { EventEmitter, IDisposable } from './common/events';
import { ILogger, LogTag, resolveLoggerOptions } from './common/logging';
import { MutableLaunchConfig } from './common/mutableLaunchConfig';
import { mapValues, once, truthy } from './common/objUtils';
import { getDeferred } from './common/promiseUtil';
import * as urlUtils from './common/urlUtils';
import {
  AnyLaunchConfiguration,
  AnyResolvingConfiguration,
  applyDefaults,
  isNightly,
  packageVersion,
} from './configuration';
import Dap from './dap/api';
import DapConnection from './dap/connection';
import { createTargetContainer, provideLaunchParams } from './ioc';
import { disposeContainer, ExtensionLocation, IInitializeParams, IsVSCode } from './ioc-extras';
import { ITargetOrigin } from './targets/targetOrigin';
import { ILauncher, ILaunchResult, IStopMetadata, ITarget } from './targets/targets';
import { ITelemetryReporter } from './telemetry/telemetryReporter';
import {
  filterErrorsReportedToTelemetry,
  installUnhandledErrorReporter,
} from './telemetry/unhandledErrorReporter';

export interface IBinderDelegate {
  /**
   * Returns a promise that resolves to the DAP connection for the new target.
   * Generally this involves calling back to the client to initialize the
   * session, and then resolving once the client has provided a connection
   * to return.
   */
  acquireDap(target: ITarget): Promise<DapConnection>;

  /**
   * Handles launching of the session, returning `true` if the delegate
   * handled it. If `false` is returned, the binder will wait for a launch/attach
   * request on the target's DAP connection.
   */
  initAdapter(debugAdapter: DebugAdapter, target: ITarget, launcher: ILauncher): Promise<boolean>;

  /**
   * Called after a session is disconnected.
   */
  releaseDap(target: ITarget): void;
}

/**
 * The Binder handles the lifecycle of a set of debug sessions. It's initialized
 * with the root DAP, and can then handle new child sessions via calls of
 * the `.boot()` method or launch/attach calls on the DAP connection.
 *
 * The provided delegate is responsible
 *
 * It manages a tree of sessions under the `_root`, which represents the top
 * level "virtual" session. In some cases, more than one debug session can be
 * created under the top level session, but more commonly there's a single
 * session to debug a Node program or browser, for example. Under this, there
 * may be other sessions.
 *
 * The binder makes an effort to ensure load and unload order is correct, such
 * that parent sessions only send `terminated` or respond to the 'disconnect'
 * request after all their child sessions have also entered the desired state.
 *
 * @see https://microsoft.github.io/debug-adapter-protocol/overview for control flows
 */
export class Binder implements IDisposable {
  private readonly _disposables = new DisposableList();
  private _dap: Dap.Api;
  private _targetOrigin: ITargetOrigin;
  private _launchParams?: AnyLaunchConfiguration;
  private _asyncStackPolicy?: IAsyncStackPolicy;
  private _serviceTree = new WeakMap<ITarget, Container>();

  /** Root of the session tree. Undefined until a launch/attach request is received. */
  private _root = new TreeNode(undefined);

  constructor(
    private readonly _delegate: IBinderDelegate,
    connection: DapConnection,
    private readonly _rootServices: Container,
    targetOrigin: ITargetOrigin,
  ) {
    this._dap = connection.dap();
    this._targetOrigin = targetOrigin;
    this._disposables.callback(() => disposeContainer(_rootServices));
    this._disposables.push(
      installUnhandledErrorReporter(
        _rootServices.get(ILogger),
        _rootServices.get(ITelemetryReporter),
        _rootServices.get(IsVSCode),
      ),
    );

    connection.attachTelemetry(_rootServices.get(ITelemetryReporter));

    const dap = this._dap;
    let lastBreakpointId = 0;
    let selfProfile: SelfProfile | undefined;

    dap.on('initialize', async clientCapabilities => {
      this._rootServices.bind(IInitializeParams).toConstantValue(clientCapabilities);
      const capabilities = DebugAdapter.capabilities();
      if (clientCapabilities.clientID === 'vscode') {
        filterErrorsReportedToTelemetry();
      }

      setTimeout(() => dap.initialized({}), 0);
      return capabilities;
    });
    dap.on('setExceptionBreakpoints', async () => ({}));
    dap.on('setBreakpoints', async params => {
      if (params.breakpoints?.length) {
        _rootServices.get(DiagnosticToolSuggester).notifyHadBreakpoint();
      }

      return {
        breakpoints: params.breakpoints?.map(() => ({
          id: ++lastBreakpointId,
          verified: false,
          message: l10n.t('Unbound breakpoint'),
        })) ?? [],
      };
    });
    dap.on('configurationDone', async () => ({}));
    dap.on('threads', async () => ({ threads: [] }));
    dap.on('loadedSources', async () => ({ sources: [] }));
    dap.on('breakpointLocations', () => Promise.resolve({ breakpoints: [] }));
    dap.on('attach', async params => {
      await this.boot(params as AnyResolvingConfiguration, dap);
      return {};
    });
    dap.on('launch', async params => {
      await this.boot(params as AnyResolvingConfiguration, dap);
      return {};
    });
    dap.on('pause', async () => {
      return {};
    });
    dap.on('terminate', () => this._terminateRoot(true));
    dap.on('disconnect', args => this._disconnectRoot(args));
    dap.on('restart', async ({ arguments: params }) => {
      await this._restart(params as AnyResolvingConfiguration);
      return {};
    });
    dap.on('startSelfProfile', async ({ file }) => {
      selfProfile?.dispose();
      selfProfile = new SelfProfile(file);
      await selfProfile.start();
      return {};
    });
    dap.on('stopSelfProfile', async () => {
      if (selfProfile) {
        await selfProfile.stop();
        selfProfile.dispose();
        selfProfile = undefined;
      }

      return {};
    });
  }

  private readonly getLaunchers = once(() => {
    const launchers = new Set<ILauncher>(this._rootServices.getAll(ILauncher));

    for (const launcher of launchers) {
      this._disposables.push(
        launcher.onTargetListChanged(() => {
          const targets = this.targetList();
          this._attachToNewTargets(targets, launcher);
          this._terminateOrphanThreads(targets);
        }),
      );
    }

    return launchers as ReadonlySet<ILauncher>;
  });

  /**
   * Terminates all running targets. Resolves when all have terminated.
   */
  private async _terminateRoot(terminateDebuggee?: boolean) {
    this._root.state = TargetState.Terminating;
    await Promise.all([...this.getLaunchers()].map(l => l.terminate(terminateDebuggee)));
    await this._root.waitUntilChildrenAre(TargetState.Terminated);
    this._root.state = TargetState.Terminated;
    return {};
  }

  /**
   * Disconnects all running targets. Resolves when all have disconnected.
   */
  private async _disconnectRoot(args: Dap.DisconnectParams) {
    if (this._root.state < TargetState.Terminating) {
      await this._terminateRoot(args.terminateDebuggee);
    }

    this._rootServices.get<ITelemetryReporter>(ITelemetryReporter).flush();
    await this._root.waitUntilChildrenAre(TargetState.Disconnected);
    this._root.state = TargetState.Disconnected;
    return {};
  }

  /**
   * Boots the binder with the given API. Used for the dapDebugServer where
   * the launch/attach is intercepted before the binder is created.
   */
  public async boot(params: AnyResolvingConfiguration, dap: Dap.Api) {
    return this._boot(applyDefaults(params, this._rootServices.get(ExtensionLocation)), dap);
  }

  private async _boot(params: AnyLaunchConfiguration, dap: Dap.Api) {
    warnNightly(dap);
    this.reportBootTelemetry(params);
    provideLaunchParams(this._rootServices, params, dap);
    this._rootServices.get<ILogger>(ILogger).setup(resolveLoggerOptions(dap, params.trace));

    const cts = params.timeout > 0
      ? CancellationTokenSource.withTimeout(params.timeout)
      : new CancellationTokenSource();

    if (params.rootPath) params.rootPath = urlUtils.platformPathToPreferredCase(params.rootPath);
    this._launchParams = params;

    const boots = await Promise.all(
      [...this.getLaunchers()].map(l => this._launch(l, params, cts.token)),
    );

    Promise.all(boots.map(b => b.terminated)).then(allMetadata => {
      const metadata = allMetadata.find(truthy);
      this._markTargetAsTerminated(this._root, { restart: !!metadata?.restart });
    });

    return {};
  }

  private reportBootTelemetry(rawParams: AnyLaunchConfiguration) {
    const defaults = applyDefaults({
      type: rawParams.type,
      request: rawParams.request,
      name: '<string>',
      __workspaceFolder: '<workspace>',
    } as AnyResolvingConfiguration) as unknown as { [key: string]: unknown };

    // Sanitization function that strips non-default strings from the launch
    // config, to avoid unnecessarily collecting information about the workspace.
    const sanitizer = (value: unknown, key?: string): unknown => {
      if (typeof value === 'string') {
        return key && defaults[key] === value ? value : `<string>`;
      }

      if (value instanceof Array) {
        return value.map(v => sanitizer(v));
      }

      if (value && typeof value === 'object') {
        return mapValues(value as { [key: string]: unknown }, v => sanitizer(v));
      }

      return value;
    };

    this._rootServices.get<ITelemetryReporter>(ITelemetryReporter).report('launch', {
      type: rawParams.type,
      request: rawParams.request,
      os: `${os.platform()} ${os.arch()}`,
      nodeVersion: process.version,
      adapterVersion: packageVersion,
      parameters: mapValues(rawParams as unknown as { [key: string]: unknown }, sanitizer),
    });
  }

  async _restart(newParams?: AnyResolvingConfiguration) {
    let resolved: AnyLaunchConfiguration | undefined;
    if (newParams) {
      const currentParams = this._rootServices.get<MutableLaunchConfig>(MutableLaunchConfig);
      resolved = applyDefaults(
        {
          __workspaceFolder: currentParams.__workspaceFolder,
          ...newParams,
        },
        this._rootServices.get<ExtensionLocation>(ExtensionLocation),
      );
      currentParams.update(resolved);
    }

    await Promise.all([...this.getLaunchers()].map(l => l.restart(resolved)));
  }

  async _launch(
    launcher: ILauncher,
    params: AnyLaunchConfiguration,
    cancellationToken: CancellationToken,
  ) {
    const result = await this.captureLaunch(launcher, params, cancellationToken);
    if (!result.blockSessionTermination) {
      return { terminated: Promise.resolve(undefined) };
    }

    return {
      terminated: new Promise<IStopMetadata>(resolve => {
        const listener = this._disposables.push(
          launcher.onTerminated(result => {
            listener.dispose();
            resolve(result);
          }),
        );
      }),
    };
  }

  /**
   * Launches the debug target, returning any the resolved result. Does a
   * bunch of mangling to log things, catch uncaught errors,
   * and format timeouts correctly.
   */
  private async captureLaunch(
    launcher: ILauncher,
    params: AnyLaunchConfiguration,
    cancellationToken: CancellationToken,
  ): Promise<ILaunchResult> {
    const name = launcher.constructor.name;

    let result: ILaunchResult;
    try {
      result = await launcher.launch(params, {
        telemetryReporter: this._rootServices.get(ITelemetryReporter),
        cancellationToken,
        targetOrigin: this._targetOrigin,
        dap: this._dap,
      });
    } catch (e) {
      this._rootServices.get<ILogger>(ILogger).warn(
        LogTag.RuntimeLaunch,
        'Launch returned error',
        {
          error: e,
          wasCancelled: cancellationToken.isCancellationRequested,
          name,
        },
      );

      throw e;
    }

    if (result.blockSessionTermination) {
      this._rootServices
        .get<ILogger>(ILogger)
        .info(LogTag.RuntimeLaunch, 'Launched successfully', { name });
    }

    return result;
  }

  dispose() {
    this._disposables.dispose();
    this._terminateOrphanThreads([]);
  }

  targetList(): ITarget[] {
    const result: ITarget[] = [];
    for (const delegate of this.getLaunchers()) {
      result.push(...delegate.targetList());
    }

    return result;
  }

  private async attach(node: TargetTreeNode, launcher: ILauncher) {
    if (!this._launchParams) {
      throw new Error('Cannot launch before params have been set');
    }

    const target = node.value;
    if (!target.canAttach()) {
      return;
    }
    const cdp = await target.attach();
    if (!cdp) {
      return;
    }
    const connection = await this._delegate.acquireDap(target);
    const dap = connection.dap();
    const launchParams = this._launchParams;

    if (!this._asyncStackPolicy) {
      this._asyncStackPolicy = getAsyncStackPolicy(launchParams.showAsyncStacks);
    }

    const parentTarget = target.parent();
    const parentContainer = (parentTarget && this._serviceTree.get(parentTarget))
      || this._rootServices;
    const container = createTargetContainer(parentContainer, target, dap, cdp);
    connection.attachTelemetry(container.get(ITelemetryReporter));
    this._serviceTree.set(target, parentContainer);

    const debugAdapter = new DebugAdapter(dap, this._asyncStackPolicy, launchParams, container);
    const thread = debugAdapter.createThread(cdp, target);

    const isBlazor = 'inspectUri' in launchParams && !!launchParams.inspectUri;
    if (isBlazor) {
      this.attachDotnetDebuggerEvent(
        cdp,
        this._rootServices.get(ITelemetryReporter),
        this._rootServices.get(IsVSCode),
      );
    }

    const startThread = async () => {
      await debugAdapter.launchBlocker();
      target.runIfWaitingForDebugger();
      node.threadData.resolve({ thread, debugAdapter });
      return {};
    };

    // default disconnect/terminate/restart handlers that can be overridden
    // by the delegate in initAdapter()
    dap.on('disconnect', args => this._disconnectTarget(node, args));
    dap.on('terminate', () => this._terminateTarget(node));
    dap.on('restart', async () => {
      if (target.canRestart()) {
        target.restart();
      } else {
        await this._restart();
      }

      return Promise.resolve({});
    });

    if (await this._delegate.initAdapter(debugAdapter, target, launcher)) {
      startThread();
    } else {
      dap.on('attach', startThread);
      dap.on('launch', startThread);
    }

    await target.afterBind();
  }

  private attachDotnetDebuggerEvent(
    cdp: Cdp.Api,
    telemetryReporter: ITelemetryReporter,
    isVsCode?: boolean,
  ) {
    cdp.DotnetDebugger.on('reportBlazorDebugError', event => {
      telemetryReporter.report('blazorDebugError', {
        exceptionType: event.exceptionType,
        '!error': event.error,
        error: isVsCode ? undefined : event.error,
      });
    });
  }

  private _attachToNewTargets(targets: ITarget[], launcher: ILauncher) {
    for (const target of targets.values()) {
      if (!target.waitingForDebugger()) {
        continue;
      }

      if (TreeNode.targetNodes.has(target)) {
        continue;
      }

      const parentTarget = target.parent();
      const parent = parentTarget ? TreeNode.targetNodes.get(parentTarget) : this._root;
      if (!parent) {
        throw new Error(`Got target with unknown parent: ${target.name()}`);
      }

      const node = new TreeNode(target) as TargetTreeNode;
      parent.add(node);
      this.attach(node, launcher);
    }
  }

  /**
   * Terminates all targets in the tree that aren't in the `targets` list.
   */
  private async _terminateOrphanThreads(
    targets: ITarget[],
    terminateArgs?: Dap.TerminatedEventParams,
  ) {
    const toRelease = [...this._root.all()].filter(n => !targets.includes(n.value));
    return Promise.all(toRelease.map(n => this._markTargetAsTerminated(n, terminateArgs)));
  }

  /**
   * Marks the target as terminated, called when the target lists change.
   */
  private async _markTargetAsTerminated(
    node: TreeNode,
    terminateArgs: Dap.TerminatedEventParams = {},
  ) {
    if (node.state >= TargetState.Terminating) {
      await node.waitUntil(TargetState.Terminated);
      return {};
    }

    node.state = TargetState.Terminating;
    if (isTargetTreeNode(node)) {
      const threadData = await node.threadData.promise;
      await threadData.thread.dispose();
      threadData.debugAdapter.dap.terminated(terminateArgs);
      threadData.debugAdapter.dispose();
    } else {
      this._dap.terminated(terminateArgs);
    }

    await node.waitUntilChildrenAre(TargetState.Terminated);
    node.state = TargetState.Terminated;
    return {};
  }

  /**
   * DAP method call to terminate a target. Resolves once the target and
   * all of its children have terminated.
   *
   * This doesn't actually mark a node as terminated; that's done when the
   * target is removed from the targets list as `_markTargetAsTerminated` is called.
   */
  private async _terminateTarget(node: TargetTreeNode) {
    if (node.state >= TargetState.Disconnected) {
      return {};
    }

    if (node.value.canStop()) {
      node.value.stop();
    } else {
      this._terminateRoot(true);
    }

    await node.waitUntil(TargetState.Terminated);
    return {};
  }

  /**
   * DAP method call to disconnect a target. Resolves once the target and
   * all of its children have disconnected.
   */
  private async _disconnectTarget(node: TargetTreeNode, args: Dap.DisconnectParams) {
    if (node.state >= TargetState.Disconnected) {
      return {};
    }

    if (node.state < TargetState.Terminating) {
      if (args.terminateDebuggee !== true && node.value.canDetach()) {
        await node.value.detach();
      } else if (node.value.canStop()) {
        node.value.stop();
      } else {
        this._terminateRoot(args.terminateDebuggee);
      }
    }

    await node.waitUntil(TargetState.Terminated);
    await node.waitUntilChildrenAre(TargetState.Disconnected);
    node.state = TargetState.Disconnected;
    queueMicrotask(() => this._delegate.releaseDap(node.value));

    const parentTarget = node.value.parent();
    const parentNode = parentTarget ? TreeNode.targetNodes.get(parentTarget) : this._root;
    parentNode?.remove(node);

    return {};
  }
}

function warnNightly(dap: Dap.Api): void {
  if (isNightly) {
    dap.output({
      category: 'console',
      output: `Note: Using the "preview" debug extension\n`,
    });
  }
}

const enum TargetState {
  Running,
  Terminating,
  Terminated,
  Disconnected,
}

type ThreadData = { thread: Thread; debugAdapter: DebugAdapter };

type TargetTreeNode = TreeNode & { value: ITarget };

export const isTargetTreeNode = (node: TreeNode): node is TargetTreeNode => !!node.value;

/**
 * Node in the tree that manages the collective state of shutdowns, so that
 * terminations and disconnections happen gracefully in-order.
 */
class TreeNode {
  public static targetNodes = new WeakMap<ITarget, TreeNode>();
  public readonly threadData = getDeferred<ThreadData>();

  private _state = TargetState.Running;
  private readonly _children = new Set<TreeNode>();
  private readonly _stateChangeEmitter = new EventEmitter<TargetState>();

  public get state() {
    return this._state;
  }

  public set state(state: TargetState) {
    if (state > this._state) {
      this._state = state;
      this._stateChangeEmitter.fire(state);
    }
  }

  /** Value is only undefined for the root node */
  constructor(public readonly value: ITarget | undefined) {
    if (value) {
      TreeNode.targetNodes.set(value, this);
    }
  }

  /**
   * Adds a new child to the target tree.
   */
  public add(child: TreeNode) {
    this._children.add(child);
  }

  /**
   * Removes a child to the target tree.
   */
  public remove(child: TreeNode) {
    this._children.delete(child);
  }

  /**
   * Returns a promise that resolves when this node has reached at least the
   * given state in the lifecycle.
   */
  public async waitUntil(state: TargetState) {
    if (this._state >= state) {
      return Promise.resolve();
    }

    return new Promise<void>(resolve => {
      const l = this._stateChangeEmitter.event(s => {
        if (s >= state) {
          l.dispose();
          resolve();
        }
      });
    });
  }

  /**
   * Returns a promise that resolves when all children this node have reached
   * at least the given state.
   */
  public async waitUntilChildrenAre(state: TargetState) {
    await Promise.all([...this._children].map(c => c.waitUntil(state)));
  }

  /**
   * Returns an iterator that lists all targets in the tree.
   */
  public *all(): IterableIterator<TargetTreeNode> {
    if (isTargetTreeNode(this)) {
      yield this;
    }

    for (const child of this._children) {
      yield* child.all();
    }
  }
}
