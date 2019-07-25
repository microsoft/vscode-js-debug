/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { TestP } from '../test';
import Dap from '../../dap/api';

function logAsConsole(p: TestP, text) {
  if (!text)
    return;
  if (text.endsWith('\n'))
    text = text.substring(0, text.length - 1);
  p.log(text);
}

export async function logVariable(p: TestP, variable: Dap.Variable, depth: number = 1, indent?: string) {
  if (depth < 0)
    return;
  indent = indent || '';
  const name = variable.name ? `${variable.name}: ` : '';
  const value = variable.value || '';
  const type = variable.type ? `type=${variable.type}` : '';
  const namedCount = variable.namedVariables ? ` named=${variable.namedVariables}` : '';
  const indexedCount = variable.indexedVariables ? ` indexed=${variable.indexedVariables}` : '';

  let suffix = `${type}${namedCount}${indexedCount}`;
  if (suffix)
    suffix = '  // ' + suffix;
  const line = `${name}${value}${suffix}`;
  if (line)
    logAsConsole(p, `${indent}${line}`);
  if (variable.variablesReference) {
    const hasHints = typeof variable.namedVariables === 'number' || typeof variable.indexedVariables === 'number' ;
    if (!hasHints || variable.namedVariables) {
      const named = await p.dap.variables({
        variablesReference: variable.variablesReference,
        filter: 'named'
      });
      for (const variable of named.variables)
        await logVariable(p, variable, depth - 1, indent + '    ');
    }
    if (hasHints && variable.indexedVariables) {
      const indexed = await p.dap.variables({
        variablesReference: variable.variablesReference,
        filter: 'indexed',
        start: 0,
        count: variable.indexedVariables
      });
      for (const variable of indexed.variables)
        await logVariable(p, variable, depth - 1, indent + '    ');
    }
  }
}

export async function logOutput(p: TestP, params: Dap.OutputEventParams) {
  const prefix = `${params.category}> `;
  if (params.output)
    logAsConsole(p, `${prefix}${params.output}`);
  if (params.variablesReference) {
    const result = await p.dap.variables({ variablesReference: params.variablesReference });
    for (const variable of result.variables)
      await logVariable(p, variable, 1, prefix);
  }
}

export async function logEvaluateResult(p: TestP, expression: string, depth: number = 1) {
  const result = await p.dap.evaluate({ expression });
  await logVariable(p, { name: 'result', value: result.result, ...result }, depth);
}