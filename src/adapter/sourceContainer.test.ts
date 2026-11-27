/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import Cdp from '../cdp/api';
import { ILogger } from '../common/logging';
import { upcastPartial } from '../common/objUtils';
import { getDeferred } from '../common/promiseUtil';
import { ISourceMapFactory } from '../common/sourceMaps/sourceMapFactory';
import { ISourcePathResolver } from '../common/sourcePathResolver';
import { AnyLaunchConfiguration } from '../configuration';
import Dap from '../dap/api';
import { stubbedDapApi } from '../dap/stubbedApi';
import { IWasmSymbolProvider } from './dwarf/wasmSymbolProvider';
import { IResourceProvider } from './resourceProvider';
import { ScriptSkipper } from './scriptSkipper/implementation';
import { SourceContainer } from './sourceContainer';

describe('SourceContainer', () => {
  it('reuses a source registered while its URL was resolving', async () => {
    const firstResolution = getDeferred<string | undefined>();
    const secondResolution = getDeferred<string | undefined>();
    const resolutions = [firstResolution.promise, secondResolution.promise];
    const sourcePathResolver = upcastPartial<ISourcePathResolver>({
      urlToAbsolutePath: () => resolutions.shift() ?? Promise.resolve(undefined),
    });
    const scriptSkipper = upcastPartial<ScriptSkipper>({
      setSourceContainer: () => undefined,
      initializeSkippingValueForSource: () => undefined,
    });
    const sourceContainer = new SourceContainer(
      stubbedDapApi().actual,
      upcastPartial<ISourceMapFactory>({}),
      upcastPartial<ILogger>({
        verbose: () => undefined,
        assert: <T>(value: T | false | null | undefined): value is T => !!value,
      }),
      upcastPartial<AnyLaunchConfiguration>({
        sourceMaps: true,
        timeouts: {},
      }),
      upcastPartial<Dap.InitializeParams>({}),
      sourcePathResolver,
      scriptSkipper,
      upcastPartial<IResourceProvider>({}),
      upcastPartial<IWasmSymbolProvider>({}),
    );
    const event = (scriptId: string) =>
      upcastPartial<Cdp.Debugger.ScriptParsedEvent>({
        scriptId,
        url: 'file:///shared.js',
        hash: 'same-content',
      });

    const firstAdd = sourceContainer.addSource(
      event('1'),
      async () => undefined,
      undefined,
      undefined,
      undefined,
      'same-content',
    );
    const secondAdd = sourceContainer.addSource(
      event('2'),
      async () => undefined,
      undefined,
      undefined,
      undefined,
      'same-content',
    );

    firstResolution.resolve(undefined);
    const firstSource = await firstAdd;
    secondResolution.resolve(undefined);
    const secondSource = await secondAdd;

    expect(secondSource).to.equal(firstSource);
    expect(sourceContainer.getSourceByOriginalUrl(event('1').url)).to.equal(firstSource);
  });
});
