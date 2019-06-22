/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import {Target} from './targetManager';
import * as debug from 'debug';
import {DebugProtocol} from 'vscode-debugprotocol';
import Protocol from 'devtools-protocol';
import {EventEmitter} from 'events';

const debugThread = debug('thread');

export const ThreadEvents = {
  ThreadNameChanged: Symbol('ThreadNameChanged'),
  ThreadPaused: Symbol('ThreadPaused'),
  ThreadResumed: Symbol('ThreadResumed'),
  ScriptAdded: Symbol('ScriptAdded'),
  ScriptsRemoved: Symbol('ScriptsRemoved'),
};

export class Script {
  private static _lastSourceReference = 0;

  private _thread: Thread;
  private _event: Protocol.Debugger.ScriptParsedEvent;
  private _sourceReference: number;
  private _source?: string;

  constructor(thread: Thread, event: Protocol.Debugger.ScriptParsedEvent) {
    this._thread = thread;
    this._event = event;
    this._sourceReference = ++Script._lastSourceReference;
  }

  sourceReference(): number {
    return this._sourceReference;
  }

  toDap(): DebugProtocol.Source {
    return {
      name: this._event.url,
      sourceReference: this._sourceReference,
      presentationHint: 'normal'
    };
  }

  async source() {
    if (this._source === undefined) {
      const response = await this._thread._target.cdp().Debugger.getScriptSource({
        scriptId: this._event.scriptId
      });
      this._source = response.scriptSource;
    }
    return this._source;
  }
}

export class Thread extends EventEmitter {
  private static _lastThreadId: number = 0;

  _target: Target;
  private _threadId: number;
  private _threadName: string;
  private _pausedDetails?: Protocol.Debugger.PausedEvent;
  private _scripts: Map<string, Script> = new Map();

  constructor(target: Target) {
    super();
    this._target = target;
    this._threadId = ++Thread._lastThreadId;
    this._threadName = '';
    debugThread(`Thread created #${this._threadId}`);
  }

  threadId(): number {
    return this._threadId;
  }

  toDap(): DebugProtocol.Thread {
    return {id: this._threadId, name: this._threadName};
  }

  pausedDetails(): Protocol.Debugger.PausedEvent | undefined {
    return this._pausedDetails;
  }

  scripts(): Map<string, Script> {
    return this._scripts;
  }

  resume() {
    this._target.cdp().Debugger.resume();
  }

  async initialize() {
    const cdp = this._target.cdp();
    cdp.Runtime.on('executionContextsCleared', () => this._reset());
    await cdp.Runtime.enable();
    cdp.Debugger.on('paused', event => {
      this._pausedDetails = event;
      this.emit(ThreadEvents.ThreadPaused, this);
    });
    cdp.Debugger.on('resumed', () => {
      this._pausedDetails = null;
      this.emit(ThreadEvents.ThreadResumed, this);
    });
    cdp.Debugger.on('scriptParsed', (event: Protocol.Debugger.ScriptParsedEvent) => {
      const script = new Script(this, event);
      console.assert(!this._scripts.has(event.scriptId));
      this._scripts.set(event.scriptId, script);
      this.emit(ThreadEvents.ScriptAdded, script);
    });
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
    this.emit(ThreadEvents.ScriptsRemoved, scripts);
  }
}
