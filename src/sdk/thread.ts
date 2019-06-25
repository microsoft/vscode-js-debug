/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import {Target} from './targetManager';
import * as debug from 'debug';
import {EventEmitter} from 'events';
import {Source} from './source';
import * as utils from '../utils';
import {Cdp, CdpApi} from '../cdp/api';

const debugThread = debug('thread');

export const ThreadEvents = {
  ThreadNameChanged: Symbol('ThreadNameChanged'),
  ThreadPaused: Symbol('ThreadPaused'),
  ThreadResumed: Symbol('ThreadResumed'),
  ThreadConsoleMessage: Symbol('ThreadConsoleMessage'),
};

export class Thread extends EventEmitter {
  private static _lastThreadId: number = 0;

  _target: Target;
  private _threadId: number;
  private _threadName: string;
  private _pausedDetails?: Cdp.Debugger.PausedEvent;
  private _scripts: Map<string, Source> = new Map();

  constructor(target: Target) {
    super();
    this._target = target;
    this._threadId = ++Thread._lastThreadId;
    this._threadName = '';
    debugThread(`Thread created #${this._threadId}`);
  }

  cdp(): CdpApi {
    return this._target.cdp();
  }

  threadId(): number {
    return this._threadId;
  }

  threadName(): string {
    return this._threadName;
  }

  pausedDetails(): Cdp.Debugger.PausedEvent | undefined {
    return this._pausedDetails;
  }

  scripts(): Map<string, Source> {
    return this._scripts;
  }

  resume() {
    this._target.cdp().Debugger.resume();
  }

  async initialize() {
    const cdp = this._target.cdp();
    cdp.Runtime.on('executionContextsCleared', () => this._reset());
    cdp.Runtime.on('consoleAPICalled', event => {
      this.emit(ThreadEvents.ThreadConsoleMessage, { thread: this, event });
    });
    await cdp.Runtime.enable();
    cdp.Debugger.on('paused', event => {
      this._pausedDetails = event;
      this.emit(ThreadEvents.ThreadPaused, this);
    });
    cdp.Debugger.on('resumed', () => {
      this._pausedDetails = null;
      this.emit(ThreadEvents.ThreadResumed, this);
    });
    cdp.Debugger.on('scriptParsed', (event: Cdp.Debugger.ScriptParsedEvent) => this._onScriptParsed(event));
    await cdp.Debugger.enable({});
  }

  async dispose() {
    this._reset();
    debugThread(`Thread destroyed #${this._threadId}: ${this._threadName}`);
  }

  setThreadName(threadName: string) {
    this._threadName = threadName;
    debugThread(`Thread renamed #${this._threadId}: ${this._threadName}`);
    this.emit(ThreadEvents.ThreadNameChanged, this);
  }

  _reset() {
    const scripts = Array.from(this._scripts.values());
    this._scripts.clear();
    this._target.sourceContainer().removeSources(...scripts);
  }

  _onScriptParsed(event: Cdp.Debugger.ScriptParsedEvent) {
    const readableUrl = event.url || `VM${event.scriptId}`;
    const source = Source.createWithContentGetter(readableUrl, async () => {
      const response = await this._target.cdp().Debugger.getScriptSource({scriptId: event.scriptId});
      return response.scriptSource;
    });
    this._scripts.set(event.scriptId, source);
    this._target.sourceContainer().addSource(source);
    if (event.sourceMapURL) {
      // TODO(dgozman): reload source map when target url changes.
      const resolvedSourceUrl = utils.completeUrl(this._target.url(), event.url);
      const resolvedSourceMapUrl = resolvedSourceUrl && utils.completeUrl(resolvedSourceUrl, event.sourceMapURL);
      if (resolvedSourceMapUrl)
        this._target.sourceContainer().attachSourceMap(source, resolvedSourceMapUrl);
    }
  }
};
