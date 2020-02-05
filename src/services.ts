/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { AnyLaunchConfiguration } from './configuration';
import { SourceMapFactory } from './common/sourceMaps/sourceMapFactory';
import { BreakpointsPredictor } from './adapter/breakpointPredictor';
import { join } from 'path';
import { CorrelatedCache } from './common/sourceMaps/mtimeCorrelatedCache';
import { ISourcePathResolver } from './common/sourcePathResolver';
import { CodeSearchSourceMapRepository } from './common/sourceMaps/codeSearchSourceMapRepository';
import { ISourceMapRepository } from './common/sourceMaps/sourceMapRepository';
import Dap from './dap/api';

/**
 * Collection of services returned from {@link IServiceFactory.create()}
 */
export interface IServiceCollection {
  bpPredictor: BreakpointsPredictor;
  sourceMapRepo: ISourceMapRepository;
}

/**
 * Common params passed to create().
 */
export interface IServiceParams {
  dap: Dap.Api;
  params: AnyLaunchConfiguration;
  sourcePathResolver: ISourcePathResolver;
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

/**
 * Services passed down between {@link NestedServiceFactory} instances. At
 * the time of writing, this happens to be the same as IServiceCollection,
 * but this is happenstance.
 */
interface IInheritedServices {
  bpPredictor: BreakpointsPredictor;
  sourceMapRepo: ISourceMapRepository;
}

/**
 * The global factory that creates services for top-level sessions.
 */
export class TopLevelServiceFactory implements IServiceFactory {
  private created?: IInheritedServices;

  public get child() {
    if (!this.created) {
      throw new Error('Cannot create child sessions before getting top-level services');
    }

    return new NestedServiceFactory(this.created);
  }

  /**
   * @inheritdoc
   */
  public create({ dap, params, sourcePathResolver }: IServiceParams) {
    const sourceMapRepo = CodeSearchSourceMapRepository.createOrFallback();
    const sourceMapFactory = new SourceMapFactory();
    const bpPredictor = new BreakpointsPredictor(
      params,
      sourceMapRepo,
      sourceMapFactory,
      sourcePathResolver,
      params.__workspaceCachePath
        ? new CorrelatedCache(join(params.__workspaceCachePath, 'bp-predict.json'))
        : undefined,
    );

    bpPredictor?.onLongParse(() => dap.longPrediction({}));

    this.created = {
      bpPredictor,
      sourceMapRepo,
    };

    return { bpPredictor, sourceMapRepo };
  }
}

export class NestedServiceFactory implements IServiceFactory {
  constructor(private readonly inherited: IInheritedServices) {}

  public get child() {
    return this; // todo: override if we need to
  }

  public create() {
    return this.inherited;
  }
}
