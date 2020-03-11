/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

// important! This must come before anything else
import 'reflect-metadata';

import { Container, interfaces } from 'inversify';
import * as vscode from 'vscode';
import { BreakpointsPredictor, IBreakpointsPredictor } from './adapter/breakpointPredictor';
import { IScriptSkipper, ScriptSkipper } from './adapter/scriptSkipper';
import Cdp from './cdp/api';
import { ICdpApi } from './cdp/connection';
import { ILogger } from './common/logging';
import { Logger } from './common/logging/logger';
import { CodeSearchSourceMapRepository } from './common/sourceMaps/codeSearchSourceMapRepository';
import { CachingSourceMapFactory, ISourceMapFactory } from './common/sourceMaps/sourceMapFactory';
import { ISourceMapRepository } from './common/sourceMaps/sourceMapRepository';
import { ISourcePathResolver } from './common/sourcePathResolver';
import { AnyLaunchConfiguration } from './configuration';
import Dap from './dap/api';
import { IDapApi } from './dap/connection';
import {
  BrowserFinderCtor,
  ChromeBrowserFinder,
  EdgeBrowserFinder,
} from 'vscode-js-debug-browsers';
import {
  ExtensionContext,
  IsVSCode,
  StoragePath,
  trackDispose,
  ProcessEnv,
  Execa,
  FS,
  BrowserFinder,
  ExtensionLocation,
  IContainer,
} from './ioc-extras';
import { BrowserAttacher } from './targets/browser/browserAttacher';
import { ChromeLauncher } from './targets/browser/chromeLauncher';
import { EdgeLauncher } from './targets/browser/edgeLauncher';
import { DelegateLauncherFactory } from './targets/delegate/delegateLauncherFactory';
import { ExtensionHostAttacher } from './targets/node/extensionHostAttacher';
import { ExtensionHostLauncher } from './targets/node/extensionHostLauncher';
import { NodeAttacher } from './targets/node/nodeAttacher';
import { NodeLauncher } from './targets/node/nodeLauncher';
import { INodePathProvider, NodePathProvider } from './targets/node/nodePathProvider';
import { INvmResolver, NvmResolver } from './targets/node/nvmResolver';
import { IProgramLauncher } from './targets/node/processLauncher';
import { RestartPolicyFactory } from './targets/node/restartPolicy';
import { SubprocessProgramLauncher } from './targets/node/subprocessProgramLauncher';
import { TerminalProgramLauncher } from './targets/node/terminalProgramLauncher';
import { ITargetOrigin } from './targets/targetOrigin';
import { ILauncher, ITarget } from './targets/targets';
import execa from 'execa';
import { promises as fsPromises } from 'fs';
import { RemoteBrowserLauncher } from './targets/browser/remoteBrowserLauncher';
import { SourcePathResolverFactory } from './targets/sourcePathResolverFactory';
import { ICompletions, Completions } from './adapter/completions';
import { IEvaluator, Evaluator } from './adapter/evaluator';
import { ProfilerFactory, IProfilerFactory } from './adapter/profiling';
import { BasicCpuProfiler } from './adapter/profiling/basicProfiler';
import { IProfileController, ProfileController } from './adapter/profileController';

/**
 * Contains IOC container factories for the extension. We use Inverisfy, which
 * supports nested IOC containers. We have one global container, containing
 * the base extension information (like temp storage path) and delegate
 * launcher.
 *
 * For each new top-level session, we create a corresponding top-level
 * container this contains shared information, such as the logger instance,
 * common launcher implementations, etc.
 *
 * Then, for each target we receive, we create child containers. The containers
 * contain the relevant ITarget, DAP and CDP APIs, any session-specific
 * services. For some services, like the script skipper (todo), it may
 * communicate with the instance in its parent container.
 */

/**
 * Gets the container for a single target within a session.
 */
export const createTargetContainer = (
  parent: Container,
  target: ITarget,
  dap: Dap.Api,
  cdp: Cdp.Api,
) => {
  const container = new Container();
  container.parent = parent;
  container.bind(IContainer).toConstantValue(container);

  container.bind(IDapApi).toConstantValue(dap);
  container.bind(ICdpApi).toConstantValue(cdp);
  container.bind(ITarget).toConstantValue(target);
  container.bind(ITargetOrigin).toConstantValue(target.targetOrigin());
  container.bind(ISourcePathResolver).toConstantValue(target.sourcePathResolver());

  container
    .bind(IScriptSkipper)
    .to(ScriptSkipper)
    .inSingletonScope();

  container
    .bind(ICompletions)
    .to(Completions)
    .inSingletonScope();

  container
    .bind(IEvaluator)
    .to(Evaluator)
    .inSingletonScope();

  container.bind(BasicCpuProfiler).toSelf();

  container
    .bind(IProfilerFactory)
    .to(ProfilerFactory)
    .inSingletonScope();

  container
    .bind(IProfileController)
    .to(ProfileController)
    .inSingletonScope();

  return container;
};

export interface IRootOptions {
  delegateLauncher: DelegateLauncherFactory;
}

/**
 * Creates a container for the top-level "virtual" debug session, containing
 * shared/global services.
 */
export const createTopLevelSessionContainer = (parent: Container) => {
  const container = new Container();
  container.parent = parent;
  container.bind(IContainer).toConstantValue(container);

  // Core services:
  container
    .bind(ILogger)
    .to(Logger)
    .inSingletonScope()
    .onActivation(trackDispose);

  // Source handling:
  container
    .bind(ISourceMapFactory)
    .to(CachingSourceMapFactory)
    .inSingletonScope()
    .onActivation(trackDispose);

  container
    .bind(IBreakpointsPredictor)
    .to(BreakpointsPredictor)
    .inSingletonScope();

  container
    .bind(ISourceMapRepository)
    .toDynamicValue(ctx =>
      CodeSearchSourceMapRepository.createOrFallback(ctx.container.get<ILogger>(ILogger)),
    )
    .inSingletonScope();

  container.bind(INodePathProvider).to(NodePathProvider);

  // Launcher logic:
  container.bind(RestartPolicyFactory).toSelf();
  container
    .bind(ILauncher)
    .to(ExtensionHostAttacher)
    .onActivation(trackDispose);
  container
    .bind(ILauncher)
    .to(ExtensionHostLauncher)
    .onActivation(trackDispose);
  container
    .bind(ILauncher)
    .to(NodeLauncher)
    .onActivation(trackDispose);
  container.bind(IProgramLauncher).to(SubprocessProgramLauncher);
  container.bind(IProgramLauncher).to(TerminalProgramLauncher);

  if (parent.get(IsVSCode)) {
    // dynamic require to not break the debug server
    container
      .bind(ILauncher)
      .to(require('./targets/node/terminalNodeLauncher').TerminalNodeLauncher)
      .onActivation(trackDispose);
  }

  container
    .bind(ILauncher)
    .to(NodeAttacher)
    .onActivation(trackDispose);

  if (container.get<ExtensionLocation>(ExtensionLocation) === 'local') {
    container
      .bind(ChromeLauncher)
      .toSelf()
      .inSingletonScope()
      .onActivation(trackDispose);
    container.bind(ILauncher).toService(ChromeLauncher);
    container
      .bind(ILauncher)
      .to(EdgeLauncher)
      .inSingletonScope()
      .onActivation(trackDispose);
  } else {
    container
      .bind(ILauncher)
      .to(RemoteBrowserLauncher)
      .inSingletonScope()
      .onActivation(trackDispose);
  }

  container
    .bind(ILauncher)
    .to(BrowserAttacher)
    .onActivation(trackDispose);
  container
    .bind(ILauncher)
    .toDynamicValue(() => parent.get(DelegateLauncherFactory).createLauncher())
    .inSingletonScope();

  const browserFinderFactory = (ctor: BrowserFinderCtor) => (ctx: interfaces.Context) =>
    new ctor(ctx.container.get(ProcessEnv), ctx.container.get(FS), ctx.container.get(Execa));

  container
    .bind(BrowserFinder)
    .toDynamicValue(browserFinderFactory(ChromeBrowserFinder))
    .inSingletonScope()
    .whenTargetTagged('browser', 'chrome');
  container
    .bind(BrowserFinder)
    .toDynamicValue(browserFinderFactory(EdgeBrowserFinder))
    .inSingletonScope()
    .whenTargetTagged('browser', 'edge');

  return container;
};

export const createGlobalContainer = (options: {
  storagePath: string;
  isVsCode: boolean;
  isRemote?: boolean;
  context?: vscode.ExtensionContext;
}) => {
  const container = new Container();
  container.bind(IContainer).toConstantValue(container);

  container
    .bind(DelegateLauncherFactory)
    .toSelf()
    .inSingletonScope();

  container.bind(StoragePath).toConstantValue(options.storagePath);
  container.bind(IsVSCode).toConstantValue(options.isVsCode);
  container.bind(INvmResolver).to(NvmResolver);
  container.bind(ProcessEnv).toConstantValue(process.env);
  container.bind(Execa).toConstantValue(execa);
  container.bind(FS).toConstantValue(fsPromises);
  container
    .bind<ExtensionLocation>(ExtensionLocation)
    .toConstantValue(options.isRemote ? 'remote' : 'local');

  if (options.context) {
    container.bind(ExtensionContext).toConstantValue(options.context);
  }

  // Dependency that pull from the vscode global--aren't safe to require at
  // a top level (e.g. in the debug server)
  if (options.isVsCode) {
    require('./ui/ui-ioc').registerUiComponents(container);
  }

  return container;
};

export const provideLaunchParams = (container: Container, params: AnyLaunchConfiguration) => {
  container.bind(AnyLaunchConfiguration).toConstantValue(params);

  container
    .bind(SourcePathResolverFactory)
    .toSelf()
    .inSingletonScope();

  container
    .bind(ISourcePathResolver)
    .toDynamicValue(ctx => ctx.container.get(SourcePathResolverFactory).create())
    .inSingletonScope();
};
