/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { inject, injectable } from 'inversify';
import { tmpdir } from 'os';
import { join } from 'path';
import { mapValues } from '../common/objUtils';
import { ISourceMapMetadata } from '../common/sourceMaps/sourceMap';
import { AnyLaunchConfiguration } from '../configuration';
import Dap from '../dap/api';
import { toolPath, toolStylePath } from '../diagnosticTool';
import { FS, FsPromises } from '../ioc-extras';
import { ITarget } from '../targets/targets';
import { BreakpointManager } from './breakpoints';
import {
  CdpReferenceState,
  IBreakpointCdpReferenceApplied,
  IBreakpointCdpReferencePending,
} from './breakpoints/breakpointBase';
import { isSourceWithSourceMap, IUiLocation, SourceFromMap } from './source';
import { SourceContainer } from './sourceContainer';

export interface IDiagnosticSource {
  uniqueId: number;
  url: string;
  sourceReference: number;
  absolutePath: string;
  actualAbsolutePath: string | undefined;
  scriptIds: string[];
  prettyName: string;
  compiledSourceRefToUrl?: [number, string][];
  sourceMap?: {
    url: string;
    metadata: ISourceMapMetadata;
    sources: { [url: string]: number };
  };
}

export interface IDiagnosticUiLocation {
  lineNumber: number;
  columnNumber: number;
  sourceReference: number;
}

export type DiagnosticBreakpointArgs =
  | Omit<IBreakpointCdpReferencePending, 'done'>
  | (Omit<IBreakpointCdpReferenceApplied, 'uiLocations'> & {
    uiLocations: IDiagnosticUiLocation[];
  });

export interface IDiagnosticBreakpoint {
  source: Dap.Source;
  params: Dap.SourceBreakpoint;
  cdp: DiagnosticBreakpointArgs[];
}

export interface IDiagnosticDump {
  sources: IDiagnosticSource[];
  breakpoints: IDiagnosticBreakpoint[];
  config: AnyLaunchConfiguration;
}

@injectable()
export class Diagnostics {
  constructor(
    @inject(FS) private readonly fs: FsPromises,
    @inject(SourceContainer) private readonly sources: SourceContainer,
    @inject(BreakpointManager) private readonly breakpoints: BreakpointManager,
    @inject(ITarget) private readonly target: ITarget,
  ) {}

  /**
   * Generates the a object containing information
   * about sources, config, and breakpoints.
   */
  public async generateObject() {
    const [sources] = await Promise.all([this.dumpSources()]);

    return {
      breakpoints: this.dumpBreakpoints(),
      sources,
      config: this.target.launchConfig,
    };
  }

  /**
   * Generates an HTML diagnostic report.
   */
  public async generateHtml(file = join(tmpdir(), 'js-debug-diagnostics.html')) {
    await this.fs.writeFile(
      file,
      `<!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Document</title>
        <style>${await this.fs.readFile(toolStylePath, 'utf-8')}<</style>
      </head>
      <body>
        <script>window.DUMP=${JSON.stringify(await this.generateObject())}</script>
        <script>${await this.fs.readFile(toolPath, 'utf-8')}</script>
      </body>
      </html>`,
    );

    return file;
  }

  private dumpBreakpoints() {
    const output: IDiagnosticBreakpoint[] = [];
    for (const list of [this.breakpoints.appliedByPath, this.breakpoints.appliedByRef]) {
      for (const breakpoints of list.values()) {
        for (const breakpoint of breakpoints) {
          const dump = breakpoint.diagnosticDump();
          output.push({
            source: dump.source,
            params: dump.params,
            cdp: dump.cdp.map(bp =>
              bp.state === CdpReferenceState.Applied
                ? { ...bp, uiLocations: bp.uiLocations.map(l => this.dumpUiLocation(l)) }
                : { ...bp, done: undefined }
            ),
          });
        }
      }
    }

    return output;
  }

  private dumpSources() {
    const output: Promise<IDiagnosticSource>[] = [];
    let idCounter = 0;
    for (const source of this.sources.sources) {
      output.push(
        (async () => ({
          uniqueId: idCounter++,
          url: source.url,
          sourceReference: source.sourceReference,
          absolutePath: source.absolutePath,
          actualAbsolutePath: await source.existingAbsolutePath(),
          scriptIds: source.scripts.map(s => s.scriptId),
          prettyName: await source.prettyName(),
          compiledSourceRefToUrl: source instanceof SourceFromMap
            ? [...source.compiledToSourceUrl.entries()].map(
              ([k, v]) => [k.sourceReference, v] as [number, string],
            )
            : undefined,
          sourceMap: isSourceWithSourceMap(source)
            ? {
              url: source.sourceMap.metadata.sourceMapUrl,
              metadata: source.sourceMap.metadata,
              sources: mapValues(
                Object.fromEntries(source.sourceMap.sourceByUrl),
                v => v.sourceReference,
              ),
            }
            : undefined,
        }))(),
      );
    }

    return Promise.all(output);
  }

  private dumpUiLocation(location: IUiLocation): IDiagnosticUiLocation {
    return {
      lineNumber: location.lineNumber,
      columnNumber: location.columnNumber,
      sourceReference: location.source.sourceReference,
    };
  }
}
