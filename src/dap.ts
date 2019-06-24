/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { DebugProtocol } from 'vscode-debugprotocol';
import * as debug from 'debug';

export interface StackTraceResult {
  stackFrames: DebugProtocol.StackFrame[];
  totalFrames?: number;
}

export interface EvaluateResult {
  result: string;
  type?: string;
  presentationHint?: DebugProtocol.VariablePresentationHint;
  variablesReference: number;
  namedVariables?: number;
  indexedVariables?: number;
}

export interface CompletionsResult {
  targets: DebugProtocol.CompletionItem[];
}

export interface LaunchParams extends DebugProtocol.LaunchRequestArguments {
  url: string;
  webRoot?: string;
}

export interface GetSourceContentResult {
  content: string;
  mimeType?: string;
}

export interface Adapter {
  initialize(params: DebugProtocol.InitializeRequestArguments): Promise<DebugProtocol.Capabilities>;
  launch(params: LaunchParams): Promise<void>;
  getThreads(): Promise<DebugProtocol.Thread[]>;
  getStackTrace(params: DebugProtocol.StackTraceArguments): Promise<StackTraceResult>;
  getScopes(params: DebugProtocol.ScopesArguments): Promise<DebugProtocol.Scope[]>;
  getVariables(params: DebugProtocol.VariablesArguments): Promise<DebugProtocol.Variable[]>;
  continue(params: DebugProtocol.ContinueArguments): Promise<void>;
  evaluate(params: DebugProtocol.EvaluateArguments): Promise<EvaluateResult>;
  completions(params: DebugProtocol.CompletionsArguments): Promise<CompletionsResult>;
  terminate(params: DebugProtocol.TerminateArguments): Promise<void>;
  disconnect(params: DebugProtocol.DisconnectArguments): Promise<void>;
  restart(params: DebugProtocol.RestartArguments): Promise<void>;
  getSources(params: DebugProtocol.LoadedSourcesArguments): Promise<DebugProtocol.Source[]>;
  getSourceContent(params: DebugProtocol.SourceArguments): Promise<GetSourceContentResult>;
  setBreakpoints(params: DebugProtocol.SetBreakpointsArguments): Promise<DebugProtocol.Breakpoint[]>;
}

export interface DidPauseDetails {
  reason: string;
  description?: string;
  threadId?: number;
  preserveFocusHint?: boolean;
  text?: string;
}

export interface Connection {
  setAdapter(adapter: Adapter): void;

  // Events
  didInitialize(): void;
  didChangeBreakpoint(reason: string, breakpoint: DebugProtocol.Breakpoint): void;
  didChangeCapabilities(capabilities: DebugProtocol.Capabilities): void;
  didResume(threadId: number): void;
  didExit(exitCode: number): void;
  didChangeSource(reason: 'new' | 'changed' | 'removed', source: DebugProtocol.Source): void;
  didChangeModule(reason: 'new' | 'changed' | 'removed', module: DebugProtocol.Module): void;
  didProduceOutput(output: string, category?: string, variablesReference?: number, source?: DebugProtocol.Source, line?: number, column?: number, data?: any): void;
  didAttachToProcess(name: string, systemProcessId?: number, isLocalProcess?: boolean, startMethod?: 'launch' | 'attach' | 'attachForSuspendedLaunch'): void;
  didPause(details: DidPauseDetails): void;
  didTerminate(restart?: any): void;
  didChangeThread(reason: string, threadId: number): void;
  didChangeScript(reason: 'new' | 'changed' | 'removed', source: DebugProtocol.Source): void;

  // Requests
}

export function createConnection(inStream: NodeJS.ReadableStream, outStream: NodeJS.WritableStream): Connection {
  return new ConnectionImpl(inStream, outStream);
}

const debugDAP = debug('dap');

class Message implements DebugProtocol.ProtocolMessage {
  seq: number;
  type: string;

  public constructor(type: string) {
    this.seq = 0;
    this.type = type;
  }
}

class Response extends Message implements DebugProtocol.Response {
  request_seq: number;
  success: boolean;
  command: string;

  public constructor(request: DebugProtocol.Request, message?: string) {
    super('response');
    this.request_seq = request.seq;
    this.command = request.command;
    if (message) {
      this.success = false;
      (<any>this).message = message;
    } else {
      this.success = true;
    }
  }
}

class Event extends Message implements DebugProtocol.Event {
  event: string;

  public constructor(event: string, body?: any) {
    super('event');
    this.event = event;
    if (body) {
      (<any>this).body = body;
    }
  }
}

class ConnectionImpl implements Connection {
  private _writableStream: NodeJS.WritableStream;
  private _parser: Parser;
  private _pendingRequests = new Map<number, (response: DebugProtocol.Response) => void>();
  private _dispatchMap = new Map<string, (params: any) => Promise<any>>();

  constructor(inStream: NodeJS.ReadableStream, outStream: NodeJS.WritableStream) {
    this._parser = new Parser(this._onMessage.bind(this));
    this._writableStream = outStream;

    inStream.on('data', (data: Buffer) => {
      this._parser.handleData(data);
    });
    inStream.on('close', () => {
    });
    inStream.on('error', (error) => {
      // error.message
    });
    outStream.on('error', (error) => {
      // error.message
    });
    inStream.resume();
  }

   public setAdapter(adapter: Adapter): void {
    this._dispatchMap = new Map();
    this._dispatchMap.set('initialize', params => adapter.initialize(params));
    this._dispatchMap.set('launch', params => adapter.launch(params));
    this._dispatchMap.set('threads', async () => {
      return {threads: await adapter.getThreads()};
    });
    this._dispatchMap.set('stackTrace', params => adapter.getStackTrace(params));
    this._dispatchMap.set('scopes', async params => {
      return {scopes: await adapter.getScopes(params)};
    });
    this._dispatchMap.set('variables', async params => {
      return {variables: await adapter.getVariables(params)};
    });
    this._dispatchMap.set('continue', async params => {
      await adapter.continue(params);
      return {allThreadsContinued: false};
    });
    this._dispatchMap.set('evaluate', params => adapter.evaluate(params));
    this._dispatchMap.set('completions', params => adapter.completions(params));
    this._dispatchMap.set('terminate', params => adapter.terminate(params));
    this._dispatchMap.set('disconnect', params => adapter.disconnect(params));
    this._dispatchMap.set('restart', params => adapter.restart(params));
    this._dispatchMap.set('loadedSources', async params => {
      return {sources: await adapter.getSources(params)};
    });
    this._dispatchMap.set('source', params => adapter.getSourceContent(params));
    this._dispatchMap.set('setBreakpoints', async params => {
      return {breakpoints: await adapter.setBreakpoints(params)};
    });
  }

  public didInitialize(): void {
    this._sendEvent('initialized');
  }

  public didChangeBreakpoint(reason: string, breakpoint: DebugProtocol.Breakpoint): void {
    this._sendEvent('breakpoint', {reason, breakpoint});
  }

  public didChangeCapabilities(capabilities: DebugProtocol.Capabilities): void {
    this._sendEvent('capabitilies', {capabilities});
  }

  public didResume(threadId: number): void {
    this._sendEvent('continued', {threadId, allThreadsContinued: false});
  }

  public didExit(exitCode: number): void {
    this._sendEvent('exited', {exitCode});
  }

  public didChangeSource(reason: 'new' | 'changed' | 'removed', source: DebugProtocol.Source): void {
    this._sendEvent('loadedSource', {reason, source});
  }

  public didChangeModule(reason: 'new' | 'changed' | 'removed', module: DebugProtocol.Module): void {
    this._sendEvent('module', {reason, module});
  }

  public didProduceOutput(output: string, category?: string, variablesReference?: number, source?: DebugProtocol.Source, line?: number, column?: number, data?: any): void {
    this._sendEvent('output', {output, category, variablesReference, source, line, column, data});
  }

  public didAttachToProcess(name: string, systemProcessId?: number, isLocalProcess?: boolean, startMethod?: 'launch' | 'attach' | 'attachForSuspendedLaunch'): void {
    this._sendEvent('process', {name, systemProcessId, isLocalProcess, startMethod});
  }

  public didPause(details: DidPauseDetails): void {
    this._sendEvent('stopped', {...details, allThreadsStopped: false});
  }

  public didTerminate(restart?: any): void {
    this._sendEvent('terminated', {restart});
  }

  public didChangeThread(reason: string, threadId: number): void {
    this._sendEvent('thread', {reason, threadId});
  }

  public didChangeScript(reason: 'new' | 'changed' | 'removed', source: DebugProtocol.Source): void {
    this._sendEvent('loadedSource', {reason, source});
  }

  private _sendEvent(event: string, params?: any): void {
    this._writeData(this._parser.wrap('event', new Event(event, params)));
  }

  public _sendResponse(response: DebugProtocol.Response): void {
    if (response.seq > 0) {
      console.error(`attempt to send more than one response for command ${response.command}`);
      return;
    }
    this._writeData(this._parser.wrap('response', response));
  }

  /*
  private sendRequest(command: string, args: any, timeout: number): Promise<DebugProtocol.Response> {
    const request: any = { command };
    if (args && Object.keys(args).length > 0)
      request.arguments = args;
    this._writeData(this._parser.wrap('request', request));

    return new Promise(cb => {
      this._pendingRequests.set(request.seq, cb);

      const timer = setTimeout(() => {
        clearTimeout(timer);
        const clb = this._pendingRequests.get(request.seq);
        if (clb) {
          this._pendingRequests.delete(request.seq);
          clb(new Response(request, 'timeout'));
        }
      }, timeout);
    });
  }
  */

  public stop(): void {
    if (this._writableStream) {
      this._writableStream.end();
      this._writableStream = null;
    }
  }

  private _writeData(data: string): void {
    if (!this._writableStream) {
      console.error('Writing to a closed connection');
      return;
    }
    this._writableStream.write(data, 'utf8');
  }

  private _onMessage(msg: DebugProtocol.ProtocolMessage): void {
    if (msg.type === 'request') {
      this._dispatchRequest(<DebugProtocol.Request> msg);
    } else if (msg.type === 'response') {
      const response = <DebugProtocol.Response> msg;
      const clb = this._pendingRequests.get(response.request_seq);
      if (clb) {
        this._pendingRequests.delete(response.request_seq);
        clb(response);
      }
    }
  }

  private async _dispatchRequest(request: DebugProtocol.Request): Promise<void> {
    const response: DebugProtocol.Response = new Response(request);
    try {
      const callback = this._dispatchMap.get(request.command);
      if (!callback) {
        console.error(`Unknown request: ${request.command}`);
        //this._sendErrorResponse(response, 1014, `Unrecognized request: ${request.command}`);
      } else {
        response.body = await callback(request.arguments);
        this._sendResponse(response);
      }
    } catch (e) {
      console.error(e);
      this._sendErrorResponse(response, 1104, `Error processing ${request.command}: ${e.stack || e.message}`);
    }
  }

  private _sendErrorResponse(response: DebugProtocol.Response, code: number, message: string): void {
    const msg : DebugProtocol.Message = {
      id: code,
      format: message
    };
    // msg.showUser = true;
    // msg.sendTelemetry = true;
    response.success = false;
    response.message = message;
    if (!response.body)
      response.body = {};
    response.body.error = msg;
    this._sendResponse(response);
  }
}

class Parser {
  private static TWO_CRLF = '\r\n\r\n';

  private _dispatchCallback: (request: DebugProtocol.ProtocolMessage) => void;
  private _rawData: Buffer;
  private _contentLength: number;
  private _sequence: number;

  constructor(dispatchCallback: (request: DebugProtocol.ProtocolMessage) => void) {
    this._dispatchCallback = dispatchCallback;
    this._sequence = 1;
    this._rawData = new Buffer(0);
  }

  public wrap(typ: 'request' | 'response' | 'event', message: DebugProtocol.ProtocolMessage): string {
    message.type = typ;
    message.seq = this._sequence++;
    const json = JSON.stringify(message);
    debugDAP('SEND ► ' + json);
    return `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`;
  }

  public handleData(data: Buffer): void {
    this._rawData = Buffer.concat([this._rawData, data]);
    while (true) {
      if (this._contentLength >= 0) {
        if (this._rawData.length >= this._contentLength) {
          const message = this._rawData.toString('utf8', 0, this._contentLength);
          this._rawData = this._rawData.slice(this._contentLength);
          this._contentLength = -1;
          if (message.length > 0) {
            try {
              let msg: DebugProtocol.ProtocolMessage = JSON.parse(message);
              debugDAP('◀ RECV ' + msg);
              this._dispatchCallback(msg);
            }
            catch (e) {
              console.error('Error handling data: ' + (e && e.message));
            }
          }
          continue;	// there may be more complete messages to process
        }
      } else {
        const idx = this._rawData.indexOf(Parser.TWO_CRLF);
        if (idx !== -1) {
          const header = this._rawData.toString('utf8', 0, idx);
          const lines = header.split('\r\n');
          for (let i = 0; i < lines.length; i++) {
            const pair = lines[i].split(/: +/);
            if (pair[0] == 'Content-Length') {
              this._contentLength = +pair[1];
            }
          }
          this._rawData = this._rawData.slice(idx + Parser.TWO_CRLF.length);
          continue;
        }
      }
      break;
    }
  }
}
