/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import { ILauncher, ILaunchResult, ITarget, IStopMetadata, ILaunchContext } from '../targets';
import { AnyLaunchConfiguration } from '../../configuration';
import { DebugType } from '../../common/contributionUtils';
import { ObservableMap } from '../../common/datastructure/observableMap';
import { EventEmitter } from '../../common/events';
import { IPendingDapApi } from '../../dap/pending-api';
import { MutableTargetOrigin } from '../targetOrigin';
import { ILogger } from '../../common/logging';
import { ProxyLogger } from '../../common/logging/proxyLogger';

export interface IDelegateRef {
  id: number;
  dap: IPendingDapApi;
  target: ITarget;
  parent?: IDelegateRef;
}

/**
 * The DelegateLauncher is a 'fake' launcher that can take launch requests
 * referencing an existing session ID.
 *
 * This is used for the debugger terminal; we create a terminal instance, which
 * sets up a debug server and gets CDP connections. We don't want to actually
 * start debugging until someone connects to us, so when that happens we store
 * the newly created target in the {@link DelegateLauncherFactory}, and
 * reference its ID in a request to launch through VS Code.
 *
 * That ends up in this launcher, which looks up and returns the existing
 * session by its ID. We also watch and proxy and children of launched targets
 * through this delegate, since they will have been getting created externally.
 */
export class DelegateLauncher implements ILauncher {
  /**
   * Target list.
   */
  private readonly targets = new ObservableMap<number, ITarget>();

  /**
   * Underlying emitter fired when sessions terminate. Listened to by the
   * binder and used to trigger a `terminate` message on the DAP.
   */
  private onTerminatedEmitter = new EventEmitter<IStopMetadata>();

  /**
   * @inheritdoc
   */
  public readonly onTerminated = this.onTerminatedEmitter.event;

  /**
   * @inheritdoc
   */
  public readonly onTargetListChanged = this.targets.onChanged;

  constructor(
    private readonly parentList: ObservableMap<number, IDelegateRef>,
    private readonly logger: ILogger,
  ) {
    parentList.onAdd(([, ref]) => {
      // we don't need to recurse upwards for the parents, since we know we
      // will have previously seen and `add()`ed its direct parent.
      if (ref.parent && this.targets.get(ref.parent.id)) {
        this.targets.add(ref.id, ref.target);
      }
    });

    parentList.onRemove(([id]) => {
      // Note that we only check the size if we actually removed something.
      // Otherwise, we could get a removal event from an old session before
      // we boot up our new terminal command.
      if (this.targets.remove(id) && !this.targets.size) {
        this.onTerminatedEmitter.fire({ killed: true, code: 0 });
      }
    });
  }

  /**
   * @inheritdoc
   */
  public async launch(
    params: AnyLaunchConfiguration,
    context: ILaunchContext,
  ): Promise<ILaunchResult> {
    if (params.type !== DebugType.Terminal || params.request !== 'attach') {
      return { blockSessionTermination: false };
    }

    const delegate = this.parentList.get(params.delegateId);
    if (delegate === undefined) {
      throw new Error(`Could not get debug session delegate ID ${params.delegateId}`);
    }

    const origin = delegate.target.targetOrigin();
    if (!(origin instanceof MutableTargetOrigin)) {
      throw new Error(`Expected delegate session to have a mutable target origin`);
    }

    const logger = delegate.target.logger;
    if (!(logger instanceof ProxyLogger)) {
      throw new Error(`Expected delegate session to have a proxy logger`);
    }

    // Update the origin to 're-home' it under the current debug session,
    // initially the debug adater will set it to a garbage string.
    origin.id = context.targetOrigin.id;

    // Update the target's logger to point to the one for the current session.
    logger.connectTo(this.logger);

    setTimeout(() => {
      this.targets.add(params.delegateId, delegate.target);
      delegate.dap.connect(context.dap);
    }, 0);

    return { blockSessionTermination: true };
  }

  /**
   * @inheritdoc
   */
  public terminate(): Promise<void> {
    for (const session of this.targets.value()) {
      session.stop();
    }

    return Promise.resolve();
  }

  /**
   * @inheritdoc
   */
  public disconnect(): Promise<void> {
    return this.terminate();
  }

  /**
   * @inheritdoc
   */
  public restart(): Promise<void> {
    for (const session of this.targets.value()) {
      session.restart();
    }

    return Promise.resolve();
  }

  /**
   * @inheritdoc
   */
  public targetList(): ITarget[] {
    return [...this.targets.value()];
  }

  /**
   * @inheritdoc
   */
  public dispose() {
    this.terminate();
  }
}
