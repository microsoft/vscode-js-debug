/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { TestP } from './test';
import Dap from '../dap/api';

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

  async logVariable(variable: Dap.Variable, depth: number = 1, indent?: string) {
    if (depth < 0)
      return;
    indent = indent || '';
    const name = variable.name ? `${variable.name}: ` : '';
    let value = variable.value || '';
    if (value.endsWith('\n'))
      value = value.substring(0, value.length - 1);
    const type = variable.type ? `type=${variable.type}` : '';
    const namedCount = variable.namedVariables ? ` named=${variable.namedVariables}` : '';
    const indexedCount = variable.indexedVariables ? ` indexed=${variable.indexedVariables}` : '';

    let suffix = `${type}${namedCount}${indexedCount}`;
    if (suffix)
      suffix = '  // ' + suffix;
    const line = `${name}${value}`;
    if (line)
      this.logAsConsole(`${indent}${line}${suffix}`);

    if (variable.variablesReference) {
      const hasHints = typeof variable.namedVariables === 'number' || typeof variable.indexedVariables === 'number';
      if (!hasHints || variable.namedVariables) {
        const named = await this._testP.dap.variables({
          variablesReference: variable.variablesReference,
          filter: 'named'
        });
        for (const variable of named.variables)
          await this.logVariable(variable, depth - 1, indent + '    ');
      }
      if (hasHints && variable.indexedVariables) {
        const indexed = await this._testP.dap.variables({
          variablesReference: variable.variablesReference,
          filter: 'indexed',
          start: 0,
          count: variable.indexedVariables
        });
        for (const variable of indexed.variables)
          await this.logVariable(variable, depth - 1, indent + '    ');
      }
    }
  }

  async logOutput(params: Dap.OutputEventParams) {
    const prefix = `${params.category}> `;
    if (params.output)
      this.logAsConsole(`${prefix}${params.output}`);
    if (params.variablesReference) {
      const result = await this._testP.dap.variables({ variablesReference: params.variablesReference });
      for (const variable of result.variables)
        await this.logVariable(variable, 1, prefix);
    }
  }

  async logEvaluateResult(expression: string, depth: number = 1) {
    const result = await this._testP.dap.evaluate({ expression });
    await this.logVariable({ name: 'result', value: result.result, ...result }, depth);
  }
}
