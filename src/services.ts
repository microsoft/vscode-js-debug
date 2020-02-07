/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { AnyLaunchConfiguration } from './configuration';
import { SourceMapFactory } from './common/sourceMaps/sourceMapFactory';
import { BreakpointsPredictor } from './adapter/breakpointPredictor';
import { join } from 'path';
import { CorrelatedCache } from './common/sourceMaps/mtimeCorrelatedCache';
import { CodeSearchSourceMapRepository } from './common/sourceMaps/codeSearchSourceMapRepository';
import { ISourceMapRepository } from './common/sourceMaps/sourceMapRepository';
import Dap from './dap/api';
import { ITarget } from './targets/targets';
import { Logger } from './common/logging/logger';
import { ILogger, resolveLoggerOptions } from './common/logging';
import { IDisposable } from './common/disposable';

/**
 * Collection of services returned from {@link IServiceFactory.create()}
 */
export interface IServiceCollection {
  bpPredictor: BreakpointsPredictor;
  sourceMapRepo: ISourceMapRepository;
  logger: ILogger;
}

/**
 * Common params passed to create().
 */
export interface IServiceParams {
  target: ITarget;
}

/**
 * An IServiceFactory is used to share services between debugging sessions.
 * It can be duplicated for children, which may create detached services.
 *
 * For using this, you shouldn't just toss *every* service in here, just ones
 * that need to be shared between debug sessions.
 */
export interface IServiceFactory {
  /**
   * Creates a new set of services for a child debug session.
   */
  create(params: IServiceParams): IServiceCollection;

  /**
   * Gets a child factory.
   */
  child: IServiceFactory;
}

interface IRootData {
  dap: Dap.Api;
  params: AnyLaunchConfiguration;
  logger: ILogger;
}

/**
 * Services passed down between {@link NestedServiceFactory} instances.
 */
interface IInheritedServices extends IRootData {
  bpPredictor?: BreakpointsPredictor;
  sourceMapRepo?: ISourceMapRepository;
}

/**
 * The global factory that creates services for top-level sessions.
 */
export class TopLevelServiceFactory implements IServiceFactory, IDisposable {
  public readonly logger = new Logger();

  private root?: IRootData;

  public get child() {
    if (!this.root) {
      throw new Error('must call provideRootData() first');
    }

    return new NestedServiceFactory(this.root);
  }

  /**
   * Must be called by the top-level session to provide initial data.
   */
  public provideRootData(data: { dap: Dap.Api; params: AnyLaunchConfiguration }) {
    this.logger.setup(resolveLoggerOptions(data.dap, data.params.trace));
    this.root = { ...data, logger: this.logger };
  }

  /**
   * @inheritdoc
   */
  public create(params: IServiceParams) {
    return this.child.create(params);
  }

  /**
   * @inheritdoc
   */
  public dispose() {
    this.root?.logger.dispose();
  }
}

export class NestedServiceFactory implements IServiceFactory {
  private readonly inherited: IInheritedServices;
  constructor({ ...inherited }: IInheritedServices) {
    this.inherited = inherited;
  }

  public get child() {
    return this; // todo: override if we need to
  }

  public create({ target }: IServiceParams): IServiceCollection {
    return {
      logger: this.inherited.logger,
      sourceMapRepo: this.getSourceMapRepo(),
      bpPredictor: this.getBpPredictor(target),
    };
  }

  private getSourceMapRepo() {
    if (!this.inherited.sourceMapRepo) {
      this.inherited.sourceMapRepo = CodeSearchSourceMapRepository.createOrFallback(
        this.inherited.logger,
      );
    }

    return this.inherited.sourceMapRepo;
  }

  private getBpPredictor(target: ITarget) {
    if (!this.inherited.bpPredictor) {
      const sourceMapFactory = new SourceMapFactory(this.inherited.logger);
      this.inherited.bpPredictor = new BreakpointsPredictor(
        this.inherited.params,
        this.getSourceMapRepo(),
        this.inherited.logger,
        sourceMapFactory,
        target.sourcePathResolver(),
        this.inherited.params.__workspaceCachePath
          ? new CorrelatedCache(join(this.inherited.params.__workspaceCachePath, 'bp-predict.json'))
          : undefined,
      );
    }

    return this.inherited.bpPredictor;
  }
}
