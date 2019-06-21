import {Target} from './targetManager';
import * as debug from 'debug';
import {DebugProtocol} from 'vscode-debugprotocol';

const debugThread = debug('thread');

export class Thread {
  private static _lastThreadId: number = 0;

  private _target: Target;
  private _threadId: number;
  private _threadName: string;

  constructor(target: Target) {
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

  async initialize() {
    await this._target.session().send('Runtime.enable');
  }

  dispose() {
    debugThread(`Thread destroyed #${this._threadId}: ${this._threadName}`);
  }

  setThreadName(threadName: string) {
    this._threadName = threadName;
    debugThread(`Thread updated #${this._threadId}: ${this._threadName}`);
  }
}
