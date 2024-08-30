/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { inject, injectable, optional } from 'inversify';
import { IVueFileMapper } from '../adapter/vueFileMapper';
import { DebugType } from '../common/contributionUtils';
import { IFsUtils, LocalFsUtils } from '../common/fsUtils';
import { ILogger } from '../common/logging';
import { ISourcePathResolver } from '../common/sourcePathResolver';
import { AnyLaunchConfiguration } from '../configuration';
import Dap from '../dap/api';
import { IInitializeParams } from '../ioc-extras';
import { ILinkedBreakpointLocation } from '../ui/linkedBreakpointLocation';
import { BlazorSourcePathResolver } from './browser/blazorSourcePathResolver';
import { baseURL } from './browser/browserLaunchParams';
import { BrowserSourcePathResolver } from './browser/browserPathResolver';
import { NodeSourcePathResolver } from './node/nodeSourcePathResolver';

export interface ISourcePathResolverFactory {
  create(c: AnyLaunchConfiguration, logger: ILogger): ISourcePathResolver;
}

export const ISourcePathResolverFactory = Symbol('ISourcePathResolverFactory');

/**
 * Path resolver that works for only Node and requires a more minimal setup,
 * can be used outside of an existing debug session.
 */
@injectable()
export class NodeOnlyPathResolverFactory implements ISourcePathResolverFactory {
  constructor(
    @inject(IFsUtils) private readonly fsUtils: LocalFsUtils,
    @optional()
    @inject(ILinkedBreakpointLocation)
    private readonly linkedBp?: ILinkedBreakpointLocation,
  ) {}

  public create(c: AnyLaunchConfiguration, logger: ILogger) {
    if (
      c.type === DebugType.Node
      || c.type === DebugType.Terminal
      || c.type === DebugType.ExtensionHost
    ) {
      return new NodeSourcePathResolver(
        this.fsUtils,
        NodeSourcePathResolver.shouldWarnAboutSymlinks(c) ? this.linkedBp : undefined,
        NodeSourcePathResolver.getOptions(c),
        logger,
      );
    }

    throw new Error(`Not usable for type ${c.type}`);
  }
}

@injectable()
export class SourcePathResolverFactory implements ISourcePathResolverFactory {
  constructor(
    @inject(IInitializeParams) private readonly initializeParams: Dap.InitializeParams,
    @inject(IVueFileMapper) private readonly vueMapper: IVueFileMapper,
    @inject(IFsUtils) private readonly fsUtils: LocalFsUtils,
    @optional()
    @inject(ILinkedBreakpointLocation)
    private readonly linkedBp?: ILinkedBreakpointLocation,
  ) {}

  public create(c: AnyLaunchConfiguration, logger: ILogger) {
    if (
      c.type === DebugType.Node
      || c.type === DebugType.Terminal
      || c.type === DebugType.ExtensionHost
    ) {
      return new NodeSourcePathResolver(
        this.fsUtils,
        NodeSourcePathResolver.shouldWarnAboutSymlinks(c) ? this.linkedBp : undefined,
        NodeSourcePathResolver.getOptions(c),
        logger,
      );
    } else {
      const isBlazor = !!c.inspectUri;
      return new (isBlazor ? BlazorSourcePathResolver : BrowserSourcePathResolver)(
        this.vueMapper,
        this.fsUtils,
        {
          workspaceFolder: c.__workspaceFolder,
          resolveSourceMapLocations: c.resolveSourceMapLocations,
          baseUrl: baseURL(c),
          localRoot: null,
          remoteRoot: null,
          pathMapping: { '/': c.webRoot, ...c.pathMapping },
          sourceMapOverrides: c.sourceMapPathOverrides,
          clientID: this.initializeParams.clientID,
          remoteFilePrefix: c.__remoteFilePrefix,
        },
        logger,
      );
    }
  }
}
