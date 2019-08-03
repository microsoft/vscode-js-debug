// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as path from 'path';
import { InlineScriptOffset, PathLocation, SourcePathResolver } from '../adapter/sources';
import Dap from '../dap/api';
import * as urlUtils from '../utils/urlUtils';
import * as sourceUtils from '../utils/sourceUtils';
import * as fsUtils from '../utils/fsUtils';

const kNodeScriptOffset: InlineScriptOffset = { lineOffset: 0, columnOffset: 62 };

type PredictedLocation = {
  source: PathLocation,
  compiled: PathLocation
};

export class NodeBreakpointsPredictor {
  _sourcePathResolver: SourcePathResolver;
  private _rootPath: string;
  private _nodeModules: Promise<string | undefined>;
  private _directoryScanners = new Map<string, DirectoryScanner>();
  _predictedLocations: PredictedLocation[] = [];

  constructor(sourcePathResolver: SourcePathResolver, rootPath: string) {
    this._sourcePathResolver = sourcePathResolver;
    this._rootPath = rootPath;

    const nodeModules = path.join(this._rootPath, 'node_modules');
    this._nodeModules = fsUtils.exists(nodeModules).then(exists => exists ? nodeModules : undefined);
  }

  async onSetBreakpoints(params: Dap.SetBreakpointsParams): Promise<void> {
    if (!params.source.path)
      return;
    const nodeModules = await this._nodeModules;
    let root: string;
    if (nodeModules && params.source.path.startsWith(nodeModules)) {
      root = path.relative(nodeModules, params.source.path);
      root = path.join(nodeModules, root.split(path.sep)[0]);
    } else {
      root = this._rootPath;
    }
    await this._directoryScanner(root).predictResolvedLocations(params);
  }

  predictResolvedLocations(location: PathLocation): PathLocation[] {
    const result: PathLocation[] = [];
    for (const p of this._predictedLocations) {
      if (p.source.absolutePath === location.absolutePath && p.source.lineNumber === location.lineNumber &&
          p.source.columnNumber === location.columnNumber) {
        result.push(p.compiled);
      }
    }
    return result;
  }

  _directoryScanner(root: string): DirectoryScanner {
    let result = this._directoryScanners.get(root);
    if (!result) {
      result = new DirectoryScanner(this, root);
      this._directoryScanners.set(root, result);
    }
    return result;
  }
}

class DirectoryScanner {
  private _predictor: NodeBreakpointsPredictor;
  private _done: Promise<void>;
  private _sourceMapUrls = new Map<string, string>();
  private _sourcePathToCompiled = new Map<string, Set<{compiledPath: string, sourceUrl: string}>>();

  constructor(predictor: NodeBreakpointsPredictor, root: string) {
    this._predictor = predictor;
    this._done = this._scan(root);
  }

  async _scan(dirOrFile: string): Promise<void> {
    const stat = await fsUtils.stat(dirOrFile);
    if (stat && stat.isFile()) {
      await this._handleFile(dirOrFile);
    } else if (stat && stat.isDirectory()) {
      const entries = await fsUtils.readdir(dirOrFile);
      const filtered = entries.filter(entry => entry !== 'node_modules');
      await Promise.all(filtered.map(entry => this._scan(path.join(dirOrFile, entry))));
    }
  }

  async _handleFile(absolutePath: string): Promise<void> {
    if (path.extname(absolutePath) !== '.js')
      return;
    const content = await fsUtils.readfile(absolutePath);
    let sourceMapUrl = sourceUtils.parseSourceMappingUrl(content);
    if (!sourceMapUrl)
      return;
    const fileUrl = this._predictor._sourcePathResolver.absolutePathToUrl(absolutePath);
    sourceMapUrl = urlUtils.completeUrl(fileUrl, sourceMapUrl);
    if (!sourceMapUrl)
      return;
    if (!sourceMapUrl.startsWith('data:') && !sourceMapUrl.startsWith('file://'))
      return;
    try {
      const map = await sourceUtils.loadSourceMap(sourceMapUrl, 0);
      if (!map)
        return;
      this._sourceMapUrls.set(absolutePath, sourceMapUrl);
      for (const url of map.sources) {
        const sourceUrl = this._predictor._sourcePathResolver.rewriteSourceUrl(url);
        const baseUrl = sourceMapUrl.startsWith('data:') ? fileUrl : sourceMapUrl;
        const resolvedUrl = urlUtils.completeUrl(baseUrl, sourceUrl) || sourceUrl;
        const resolvedPath = this._predictor._sourcePathResolver.urlToAbsolutePath(resolvedUrl);
        if (resolvedPath)
          this._addMapping(absolutePath, resolvedPath, url);
      }
      map.destroy();
    } catch (e) {
    }
  }

  _addMapping(compiledPath: string, sourcePath: string, sourceUrl: string) {
    let set = this._sourcePathToCompiled.get(sourcePath);
    if (!set) {
      set = new Set();
      this._sourcePathToCompiled.set(sourcePath, set);
    }
    set.add({compiledPath, sourceUrl});
  }

  async predictResolvedLocations(params: Dap.SetBreakpointsParams) {
    await this._done;
    const absolutePath = params.source.path!;
    const set = this._sourcePathToCompiled.get(absolutePath);
    if (!set)
      return;
    for (const {compiledPath, sourceUrl} of set) {
      const sourceMapUrl = this._sourceMapUrls.get(compiledPath);
      if (!sourceMapUrl)
        continue;
      try {
        const map = await sourceUtils.loadSourceMap(sourceMapUrl, 0);
        if (!map)
          continue;
        for (const b of params.breakpoints || []) {
          const entry = map.generatedPositionFor({source: sourceUrl, line: b.line, column: b.column || 1});
          if (entry.line === null)
            continue;
          const lineNumber = (entry.line || 1) + kNodeScriptOffset.lineOffset;
          let columnNumber = entry.column || 1;
          if (lineNumber === 1)
            columnNumber += kNodeScriptOffset.columnOffset;
          const predicted: PredictedLocation = {
            source: {
              absolutePath,
              lineNumber: b.line,
              columnNumber: b.column || 1,
            },
            compiled: {
              absolutePath: compiledPath,
              lineNumber,
              columnNumber
            }
          };
          this._predictor._predictedLocations.push(predicted);
        }
        map.destroy();
      } catch (e) {
      }
    }
  }
}
