/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import Cdp from '../cdp/api';
import * as utils from '../utils';
import * as messageFormat from './messageFormat';

const maxArrowFunctionCharacterLength = 30;
const maxPropertyPreviewLength = 50;
const maxEntryPreviewLength = 20;
const maxFunctionBodyLength = 200;
const maxMessageFormatParamLength = 1000;
const maxExceptionTitleLength = 10000;

export function previewRemoteObject(object: Cdp.Runtime.RemoteObject, context?: string): string {
  const characterBudget = context === 'repl' ? 1000 : 100;
  let result = previewRemoveObjectInternal(object, characterBudget, true);
  return result;
}

function previewRemoveObjectInternal(object: Cdp.Runtime.RemoteObject, characterBudget: number, quoteString: boolean): string {
  // Evaluating function does not produce preview object for it.
  if (object.type === 'function')
    return formatFunctionDescription(object.description || '');
  if (object.subtype === 'node')
    return object.description!;
  return object.preview ? renderPreview(object.preview, characterBudget) : renderValue(object, characterBudget, quoteString);
}

export function briefPreviewRemoteObject(object: Cdp.Runtime.RemoteObject, context?: string): string {
  // Evaluating function does not produce preview object for it.
  if (object.type === 'function')
    return formatFunctionDescription(object.description || '');
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
  if (preview.subtype === 'array')
    return renderArrayPreview(preview, characterBudget);
  if (preview.subtype as string === 'internal#entry')
    return preview.description || '';
  if (preview.type === 'object')
    return renderObjectPreview(preview, characterBudget);
  if (preview.type === 'function')
    return formatFunctionDescription(preview.description || '');
  return renderPrimitivePreview(preview, characterBudget);
}

function renderArrayPreview(preview: Cdp.Runtime.ObjectPreview, characterBudget: number): string {
  const builder = new StringBuilder(characterBudget);
  let description = preview.description!;
  if (description.startsWith('Array'))
    description = description.substring('Array'.length);
  builder.appendCanTrim(description);
  builder.appendCanSkip(' ');
  const propsBuilder = new StringBuilder(builder.budget() - 2);  // for []

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
  builder.forceAppend('[' + propsBuilder.build(', ') + ']');
  return builder.build();
}

function renderObjectPreview(preview: Cdp.Runtime.ObjectPreview, characterBudget: number): string {
  const builder = new StringBuilder(characterBudget);
  const description = preview.description === 'Object' ? '' : preview.description + ' ';
  builder.appendCanTrim(description);
  const propsBuilder = new StringBuilder(builder.budget() - 2);  // for {}

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
    return utils.trimEnd(preview.description!, characterBudget);
  return preview.description || '';
}

function renderPropertyPreview(prop: Cdp.Runtime.PropertyPreview): string {
  if (prop.type === 'function')
    return 'ƒ';
  if (prop.subtype === 'node')
    return prop.value!;
  if (prop.type === 'object')
    return '{…}';
  const value = typeof prop.value === 'undefined' ? `<${prop.type}>` : utils.trimEnd(prop.value, maxPropertyPreviewLength);
  return prop.type === 'string' ? `'${value}'` : value;
}

export function renderValue(object: Cdp.Runtime.RemoteObject, characterBudget: number, quote: boolean): string {
  if (object.unserializableValue)
    return utils.trimEnd(object.unserializableValue, characterBudget);

  if (object.type === 'string') {
    const value = utils.trimEnd(object.value, characterBudget - (quote ? 2 : 0));
    return quote ? `'${value}'` : value;
  }

  if (object.type === 'undefined')
    return 'undefined';

  if (object.subtype === 'null')
    return 'null';

  return utils.trimEnd(object.description || '', characterBudget);
}

function formatFunctionDescription(description: string, includePreview: boolean = false, defaultName: string = ''): string {
  const tokens: string[] = [];
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
    let className = defaultName;
    if (classNameMatch)
      className = classNameMatch[0].trim() || defaultName;
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
    if (defaultName)
      abbreviation = defaultName + '()';
    else if (text.length > maxArrowFunctionCharacterLength)
      abbreviation = text.substring(0, firstArrowIndex + 2) + ' {…}';
    addToken('', text, abbreviation);
  } else {
    addToken('ƒ', text, nameAndArguments(text));
  }
  return tokens.join('');

  function nameAndArguments(contents: string): string {
    const startOfArgumentsIndex = contents.indexOf('(');
    const endOfArgumentsMatch = contents.match(/\)\s*{/);
    const endIndex = endOfArgumentsMatch && endOfArgumentsMatch.index || 0;
    if (startOfArgumentsIndex !== -1 && endOfArgumentsMatch && endIndex > startOfArgumentsIndex) {
      const name = contents.substring(0, startOfArgumentsIndex).trim() || defaultName;
      const args = contents.substring(startOfArgumentsIndex, endIndex + 1);
      return name + args;
    }
    return defaultName + '()';
  }

  function addToken(prefix: string, body: string, abbreviation: string) {
    if (prefix.length)
      tokens.push(prefix + ' ');
    if (includePreview)
      tokens.push(utils.trimEnd(body.trim(), maxFunctionBodyLength));
    else
      tokens.push(abbreviation.replace(/\n/g, ' '));
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

function formatAsNumber(param: Cdp.Runtime.RemoteObject, round: boolean): string {
  const value = typeof param.value === 'number' ? param.value : +param.description!;
  return String(round ? Math.floor(value) : value);
}

function formatAsString(param: Cdp.Runtime.RemoteObject): string {
  return String(typeof param.value !== 'undefined' ? param.value : param.description);
}

export const messageFormatters: messageFormat.Formatters<Cdp.Runtime.RemoteObject> = new Map([
  ['', param => previewRemoveObjectInternal(param, maxMessageFormatParamLength, false)],
  ['s', param => formatAsString(param)],
  ['i', param => formatAsNumber(param, true)],
  ['d', param => formatAsNumber(param, true)],
  ['f', param => formatAsNumber(param, false)],
  ['c', param => messageFormat.formatCssAsAnsi(param.value)],
  ['o', param => previewRemoteObject(param)],
  ['O', param => previewRemoteObject(param)],
]);

class StringBuilder {
  private _tokens: string[] = [];
  private _budget: number;

  constructor(budget: number) {
    this._budget = budget;
  }

  appendCanSkip(text: string) {
    if (!this.hasBudget())
      return;
    if (text.length < this._budget) {
      this._tokens.push(text);
      this._budget -= text.length;
    } else {
      this._tokens.push('…');
      this._budget = 0;
    }
  }

  appendCanTrim(text: string) {
    if (!this.hasBudget())
      return;
    const trimmed = utils.trimEnd(text, this._budget)
    this._tokens.push(trimmed);
    this._budget = Math.max(0, this._budget - trimmed.length);
  }

  forceAppend(text: string) {
    this._tokens.push(text);
    this._budget = Math.max(0, this._budget - text.length);
  }

  hasBudget(): boolean {
    return this._budget > 0;
  }

  budget(): number {
    return this._budget;
  }

  build(join?: string): string {
    return this._tokens.join(join || '');
  }
}
