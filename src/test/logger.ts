/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { TestP } from './test';
import Dap from '../dap/api';

interface LogOptions {
  depth?: number,
  logInternalInfo?: boolean
}

export class Logger {
  private _testP: TestP;

  constructor(testP: TestP) {
    this._testP = testP;
  }

  logAsConsole(text: string) {
    if (!text)
      return;
    if (text.endsWith('\n'))
      text = text.substring(0, text.length - 1);
    this._testP.log(text);
  }

  async logVariable(variable: Dap.Variable, options?: LogOptions, indent?: string) {
    options = options || {};
    if (typeof options.depth !== 'number')
      options.depth = 1;
    if (options.depth < 0)
      return;
    indent = indent || '';
    const name = variable.name ? `${variable.name}: ` : '';
    let value = variable.value || '';
    if (value.endsWith('\n'))
      value = value.substring(0, value.length - 1);
    const type = variable.type ? `type=${variable.type}` : '';
    const namedCount = variable.namedVariables ? ` named=${variable.namedVariables}` : '';
    const indexedCount = variable.indexedVariables ? ` indexed=${variable.indexedVariables}` : '';

    const expanded = variable.variablesReference ? '> ' : '';
    let suffix = options.logInternalInfo ? `${type}${namedCount}${indexedCount}` : '';
    if (suffix)
      suffix = '  // ' + suffix;
    let line = `${expanded}${name}${value}`;
    if (line) {
      if (line.includes('\n'))
        line = '\n' + line;
      this.logAsConsole(`${indent}${line}${suffix}`);
    }

    if (variable.variablesReference) {
      const hasHints = typeof variable.namedVariables === 'number' || typeof variable.indexedVariables === 'number';
      if (hasHints) {
        if (variable.namedVariables) {
          const named = await this._testP.dap.variables({
            variablesReference: variable.variablesReference,
            filter: 'named'
          });
          for (const variable of named.variables)
            await this.logVariable(variable, { ...options, depth: options.depth - 1 }, indent + '    ');
        }
        if (variable.indexedVariables) {
          const indexed = await this._testP.dap.variables({
            variablesReference: variable.variablesReference,
            filter: 'indexed',
            start: 0,
            count: variable.indexedVariables
          });
          for (const variable of indexed.variables)
            await this.logVariable(variable, { ...options, depth: options.depth - 1 }, indent + '    ');
        }
      } else {
        const all = await this._testP.dap.variables({
          variablesReference: variable.variablesReference
        });
        for (const variable of all.variables)
          await this.logVariable(variable, { ...options, depth: options.depth - 1 }, indent + '    ');
  }
    }
  }

  async logOutput(params: Dap.OutputEventParams, options?: LogOptions) {
    const prefix = `${params.category}> `;
    if (params.output)
      this.logAsConsole(`${prefix}${params.output}`);
    if (params.variablesReference) {
      const result = await this._testP.dap.variables({ variablesReference: params.variablesReference });
      for (const variable of result.variables)
        await this.logVariable(variable, options, prefix);
    }
  }

  async logEvaluateResult(expression: string, options?: LogOptions): Promise<Dap.Variable> {
    const result = await this._testP.dap.evaluate({ expression });
    const variable = { name: 'result', value: result.result, ...result };
    await this.logVariable(variable, options);
    return variable;
  }

  async logStackTrace(threadId: number, withScopes?: boolean) {
    const initial = await this._testP.dap.stackTrace({threadId});
    const stack = initial.stackFrames;
    let totalFrames = initial.totalFrames || stack.length;
    while (stack.length < totalFrames) {
      const response = await this._testP.dap.stackTrace({threadId, startFrame: stack.length, levels: Math.min(20, totalFrames - stack.length)});
      stack.push(...response.stackFrames);
      if (response.totalFrames)
        totalFrames = Math.min(totalFrames, response.totalFrames);
    }
    let emptyLine = !!withScopes;
    for (const frame of stack) {
      if (emptyLine)
        this._testP.log('');
      if (frame.presentationHint === 'label') {
        this._testP.log(`----${frame.name}----`);
        emptyLine = false;
        continue;
      }
      this._testP.log(`${frame.name} @ ${frame.source ? frame.source.path! : 'unknown'}:${frame.line}:${frame.column}`);
      if (!withScopes)
        continue;
      const scopes = await this._testP.dap.scopes({frameId: frame.id});
      for (let i = 0; i < scopes.scopes.length; i++) {
        const scope = scopes.scopes[i];
        if (scope.expensive) {
          this._testP.log(`  scope #${i}: ${scope.name} [expensive]`);
          continue;
        }
        await this.logVariable({
          name: 'scope #' + i,
          value: scope.name,
          variablesReference: scope.variablesReference,
          namedVariables: scope.namedVariables,
          indexedVariables: scope.indexedVariables,
        }, {}, '  ');
      }
    }
  }

  async evaluateAndLog(expressions: string[], options?: LogOptions, context?: 'watch' | 'repl' | 'hover') {
    let complete: () => void;
    const result = new Promise(f => complete = f);
    const next = async () => {
      const expression = expressions.shift();
      if (!expression) {
        complete();
      } else {
        this._testP.log(`Evaluating: '${expression}'`);
        await this._testP.dap.evaluate({ expression, context });
      }
    };

    let chain = Promise.resolve();
    this._testP.dap.on('output', async params => {
      chain = chain.then(async () => {
        await this._testP.logger.logOutput(params, options);
        this._testP.log(``);
        next();
      });
    });

    next();
    await result;
  }
}
