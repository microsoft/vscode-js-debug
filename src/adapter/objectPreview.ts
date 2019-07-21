/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import Cdp from '../cdp/api';
import * as stringUtils from '../utils/stringUtils';
import { BudgetStringBuilder } from '../utils/budgetStringBuilder'
import * as messageFormat from './messageFormat';

const maxArrowFunctionCharacterLength = 30;
const maxPropertyPreviewLength = 100;
const maxEntryPreviewLength = 20;
const maxExceptionTitleLength = 10000;
const maxBriefPreviewLength = 100;

export const primitiveSubtypes = new Set<string|undefined>(
  ['null', 'regexp', 'date', 'error', 'proxy', 'promise', 'typedarray', 'arraybuffer', 'dataview']
);

export function isObject(object: Cdp.Runtime.ObjectPreview): boolean;
export function isObject(object: Cdp.Runtime.PropertyPreview): boolean;
export function isObject(object: Cdp.Runtime.RemoteObject): boolean;
export function isObject(object: Cdp.Runtime.RemoteObject | Cdp.Runtime.ObjectPreview | Cdp.Runtime.PropertyPreview): boolean {
  return object.type === 'object' && !primitiveSubtypes.has(object.subtype);
}

export function isArray(object: Cdp.Runtime.ObjectPreview): boolean;
export function isArray(object: Cdp.Runtime.PropertyPreview): boolean;
export function isArray(object: Cdp.Runtime.RemoteObject): boolean;
export function isArray(object: Cdp.Runtime.RemoteObject | Cdp.Runtime.ObjectPreview | Cdp.Runtime.PropertyPreview): boolean {
  return object.subtype === 'array' || object.subtype === 'typedarray';
}

export function previewRemoteObject(object: Cdp.Runtime.RemoteObject, context?: string): string {
  const characterBudget = context === 'repl' ? 1000 : 100;
  let result = previewRemoveObjectInternal(object, characterBudget, true);
  return result;
}

function previewRemoveObjectInternal(object: Cdp.Runtime.RemoteObject, characterBudget: number, quoteString: boolean): string {
  // Evaluating function does not produce preview object for it.
  if (object.type === 'function')
    return formatFunctionDescription(object.description!, characterBudget);
  if (object.subtype === 'node')
    return object.description!;
  return object.preview ? renderPreview(object.preview, characterBudget) : renderValue(object, characterBudget, quoteString);
}

export function briefPreviewRemoteObject(object: Cdp.Runtime.RemoteObject, context?: string): string {
  // Evaluating function does not produce preview object for it.
  if (object.type === 'function')
    return formatFunctionDescription(object.description!, maxBriefPreviewLength);
  return object.description || '';
}

export function propertyWeight(prop: Cdp.Runtime.PropertyDescriptor): number {
  if (prop.name === '__proto__')
    return 0;
  return 100;
}

export function privatePropertyWeight(prop: Cdp.Runtime.PrivatePropertyDescriptor): number {
  return 20;
}

export function internalPropertyWeight(prop: Cdp.Runtime.InternalPropertyDescriptor): number {
  return 10;
}

function renderPreview(preview: Cdp.Runtime.ObjectPreview, characterBudget: number): string {
  if (isArray(preview))
    return renderArrayPreview(preview, characterBudget);
  if (preview.subtype as string === 'internal#entry')
    return preview.description || '';
  if (isObject(preview))
    return renderObjectPreview(preview, characterBudget);
  if (preview.type === 'function')
    return formatFunctionDescription(preview.description!, characterBudget);
  return renderPrimitivePreview(preview, characterBudget);
}

function renderArrayPreview(preview: Cdp.Runtime.ObjectPreview, characterBudget: number): string {
  const builder = new BudgetStringBuilder(characterBudget);
  let description = preview.description!;
  if (description.startsWith('Array('))
    description = description.substring('Array'.length);
  builder.appendCanTrim(description);
  builder.appendCanSkip(' ');
  const propsBuilder = new BudgetStringBuilder(builder.budget() - 2);  // for []

  // Indexed
  let lastIndex = -1;
  for (const prop of preview.properties) {
    if (!propsBuilder.hasBudget())
      break;
    if (isNaN(prop.name as unknown as number))
      continue;
    const index = parseInt(prop.name, 10);
    if (index > lastIndex + 1)
      propsBuilder.appendCanSkip('…');
    lastIndex = index;
    propsBuilder.appendCanSkip(renderPropertyPreview(prop));
  }

  // Named
  for (const prop of preview.properties) {
    if (!propsBuilder.hasBudget())
      break;
    if (!isNaN(prop.name as unknown as number))
      continue;
    propsBuilder.appendCanSkip(`${prop.name}: ${renderPropertyPreview(prop)}`);
  }
  if (preview.overflow)
    propsBuilder.appendCanSkip('…');
  builder.forceAppend('[' + propsBuilder.build(', ') + ']');
  return builder.build();
}

function renderObjectPreview(preview: Cdp.Runtime.ObjectPreview, characterBudget: number): string {
  const builder = new BudgetStringBuilder(characterBudget);
  const description = preview.description === 'Object' ? '' : preview.description + ' ';
  builder.appendCanTrim(description);
  const propsBuilder = new BudgetStringBuilder(builder.budget() - 2);  // for {} / ()

  const primitiveValue = preview.properties.find(prop => prop.name === '[[PrimitiveValue]]');
  if (primitiveValue) {
    propsBuilder.appendCanSkip(`${renderPropertyPreview(primitiveValue)}`);
    builder.forceAppend('(' + propsBuilder.build() +')');
    return builder.build();
  }

  for (const prop of preview.properties) {
    if (!propsBuilder.hasBudget())
      break;
    propsBuilder.appendCanSkip(`${prop.name}: ${renderPropertyPreview(prop)}`);
  }

  for (const entry of (preview.entries || [])) {
    if (!propsBuilder.hasBudget())
      break;
    if (entry.key)
      propsBuilder.appendCanSkip(`${renderPreview(entry.key, maxEntryPreviewLength)} => ${renderPreview(entry.value, maxEntryPreviewLength)}`);
    else
      propsBuilder.appendCanSkip(`${renderPreview(entry.value, maxEntryPreviewLength)}`);
  }

  builder.forceAppend('{' + propsBuilder.build(', ') +'}');
  return builder.build();
}

function renderPrimitivePreview(preview: Cdp.Runtime.ObjectPreview, characterBudget: number): string {
  if (preview.subtype === 'null')
    return 'null';
  if (preview.type === 'undefined')
    return 'undefined';
  if (preview.type === 'string')
    return stringUtils.trimMiddle(preview.description!, characterBudget);
  return preview.description || '';
}

function renderPropertyPreview(prop: Cdp.Runtime.PropertyPreview): string {
  if (prop.type === 'function')
    return 'ƒ';
  if (prop.subtype === 'node')
    return prop.value!;
  if (isArray(prop))
    return prop.value!;
  if (isObject(prop))
    return '{…}';
  const value = typeof prop.value === 'undefined' ? `<${prop.type}>` : stringUtils.trimMiddle(prop.value, maxPropertyPreviewLength);
  return prop.type === 'string' ? `'${value}'` : value;
}

export function renderValue(object: Cdp.Runtime.RemoteObject, characterBudget: number, quote: boolean): string {
  if (object.unserializableValue)
    return stringUtils.trimMiddle(object.unserializableValue, characterBudget);

  if (object.type === 'string') {
    const value = stringUtils.trimMiddle(object.value, characterBudget - (quote ? 2 : 0));
    return quote ? `'${value}'` : value;
  }

  if (object.type === 'undefined')
    return 'undefined';

  if (object.subtype === 'null')
    return 'null';

  return stringUtils.trimEnd(object.description || '', characterBudget);
}

function formatFunctionDescription(description: string, characterBudget: number): string {
  const builder = new BudgetStringBuilder(characterBudget);
  const text = description
    .replace(/^function [gs]et /, 'function ')
    .replace(/^function [gs]et\(/, 'function\(')
    .replace(/^[gs]et /, '');

  // This set of best-effort regular expressions captures common function descriptions.
  // Ideally, some parser would provide prefix, arguments, function body text separately.
  const asyncMatch = text.match(/^(async\s+function)/);
  const isGenerator = text.startsWith('function*');
  const isGeneratorShorthand = text.startsWith('*');
  const isBasic = !isGenerator && text.startsWith('function');
  const isClass = text.startsWith('class ') || text.startsWith('class{');
  const firstArrowIndex = text.indexOf('=>');
  const isArrow = !asyncMatch && !isGenerator && !isBasic && !isClass && firstArrowIndex > 0;

  let textAfterPrefix: string;
  if (isClass) {
    textAfterPrefix = text.substring('class'.length);
    const classNameMatch = /^[^{\s]+/.exec(textAfterPrefix.trim());
    let className = '';
    if (classNameMatch)
      className = classNameMatch[0].trim() || '';
    addToken('class', textAfterPrefix, className);
  } else if (asyncMatch) {
    textAfterPrefix = text.substring(asyncMatch[1].length);
    addToken('async ƒ', textAfterPrefix, nameAndArguments(textAfterPrefix));
  } else if (isGenerator) {
    textAfterPrefix = text.substring('function*'.length);
    addToken('ƒ*', textAfterPrefix, nameAndArguments(textAfterPrefix));
  } else if (isGeneratorShorthand) {
    textAfterPrefix = text.substring('*'.length);
    addToken('ƒ*', textAfterPrefix, nameAndArguments(textAfterPrefix));
  } else if (isBasic) {
    textAfterPrefix = text.substring('function'.length);
    addToken('ƒ', textAfterPrefix, nameAndArguments(textAfterPrefix));
  } else if (isArrow) {
    let abbreviation = text;
    if (text.length > maxArrowFunctionCharacterLength)
      abbreviation = text.substring(0, firstArrowIndex + 2) + ' {…}';
    addToken('', text, abbreviation);
  } else {
    addToken('ƒ', text, nameAndArguments(text));
  }
  return builder.build();

  function nameAndArguments(contents: string): string {
    const startOfArgumentsIndex = contents.indexOf('(');
    const endOfArgumentsMatch = contents.match(/\)\s*{/);
    const endIndex = endOfArgumentsMatch && endOfArgumentsMatch.index || 0;
    if (startOfArgumentsIndex !== -1 && endOfArgumentsMatch && endIndex > startOfArgumentsIndex) {
      const name = contents.substring(0, startOfArgumentsIndex).trim() || '';
      const args = contents.substring(startOfArgumentsIndex, endIndex + 1);
      return name + args;
    }
    return '()';
  }

  function addToken(prefix: string, body: string, abbreviation: string) {
    if (!builder.hasBudget())
      return;
    if (prefix.length)
      builder.appendCanSkip(prefix + ' ');
    body = body.trim();
    if (body.endsWith(' { [native code] }'))
      body = body.substring(0, body.length - ' { [native code] }'.length);
    if (builder.budget() > body.length)
      builder.appendCanSkip(body);
    else
      builder.appendCanSkip(abbreviation.replace(/\n/g, ' '));
  }
}

export function previewException(exception: Cdp.Runtime.RemoteObject): { title: string, stackTrace?: string } {
  if (exception.type !== 'object')
    return { title: renderValue(exception, maxExceptionTitleLength, false) };
  const description = exception.description!;
  const firstCallFrame = /^\s+at\s/m.exec(description);
  if (!firstCallFrame) {
    const lastLineBreak = description.lastIndexOf('\n');
    if (lastLineBreak === -1)
      return { title: description };
    return { title: description.substring(0, lastLineBreak) };
  }
  return {
    title: description.substring(0, firstCallFrame.index - 1),
    stackTrace: description.substring(firstCallFrame.index + 2),
  };
}

function formatAsNumber(param: Cdp.Runtime.RemoteObject, round: boolean, characterBudget: number): string {
  const value = typeof param.value === 'number' ? param.value : +param.description!;
  return stringUtils.trimEnd(String(round ? Math.floor(value) : value), characterBudget);
}

function formatAsString(param: Cdp.Runtime.RemoteObject, characterBudget: number): string {
  return stringUtils.trimMiddle(String(typeof param.value !== 'undefined' ? param.value : param.description), characterBudget);
}

export const messageFormatters: messageFormat.Formatters<Cdp.Runtime.RemoteObject> = new Map([
  ['', (param, characterBudget: number) => previewRemoveObjectInternal(param, characterBudget, false)],
  ['s', (param, characterBudget: number) => formatAsString(param, characterBudget)],
  ['i', (param, characterBudget: number) => formatAsNumber(param, true, characterBudget)],
  ['d', (param, characterBudget: number) => formatAsNumber(param, true, characterBudget)],
  ['f', (param, characterBudget: number) => formatAsNumber(param, false, characterBudget)],
  ['c', (param) => messageFormat.formatCssAsAnsi(param.value)],
  ['o', (param, characterBudget: number) => previewRemoveObjectInternal(param, characterBudget, false)],
  ['O', (param, characterBudget: number) => previewRemoveObjectInternal(param, characterBudget, false)]
]);
