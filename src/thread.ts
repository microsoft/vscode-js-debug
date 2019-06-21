import {Target} from './targetManager';
import * as debug from 'debug';
import {DebugProtocol} from 'vscode-debugprotocol';
import Protocol from 'devtools-protocol';
import {EventEmitter} from 'events';

const debugThread = debug('thread');

export const ThreadEvents = {
  ThreadPaused: Symbol('ThreadPaused'),
  ThreadResumed: Symbol('ThreadResumed'),
};

export class Thread extends EventEmitter {
  private static _lastThreadId: number = 0;

  private _target: Target;
  private _threadId: number;
  private _threadName: string;
  private _pausedDetails?: Protocol.Debugger.PausedEvent;

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

  resume() {
    this._target.session().send('Debugger.resume');
  }

  async initialize() {
    const session = this._target.session();
    await session.send('Runtime.enable');
    session.on('Debugger.paused', (event: Protocol.Debugger.PausedEvent) => {
      this._pausedDetails = event;
      this.emit(ThreadEvents.ThreadPaused);
    });
    session.on('Debugger.resumed', event => {
      this._pausedDetails = null;
      this.emit(ThreadEvents.ThreadResumed);
    });
    await session.send('Debugger.enable');
  }

  dispose() {
    debugThread(`Thread destroyed #${this._threadId}: ${this._threadName}`);
  }

  setThreadName(threadName: string) {
    this._threadName = threadName;
    debugThread(`Thread updated #${this._threadId}: ${this._threadName}`);
  }
}
