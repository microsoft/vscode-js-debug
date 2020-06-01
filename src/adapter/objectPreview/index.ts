/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import Cdp from '../../cdp/api';
import * as stringUtils from '../../common/stringUtils';
import { BudgetStringBuilder } from '../../common/budgetStringBuilder';
import * as messageFormat from '../messageFormat';
import { getContextForType, IPreviewContext } from './contexts';
import * as ObjectPreview from './betterTypes';

const maxArrowFunctionCharacterLength = 30;
const maxPropertyPreviewLength = 100;
const maxEntryPreviewLength = 20;
const maxExceptionTitleLength = 10000;
const minTableCellWidth = 3;
const maxTableWidth = 120;

/**
 * Object subtypes that should be rendered without any preview.
 */
export const subtypesWithoutPreview: ReadonlySet<string | undefined> = new Set([
  'null',
  'regexp',
  'date',
]);

/**
 * Returns whether the given type should be previewed as an expandable
 * object.
 */
export function previewAsObject(
  object: Cdp.Runtime.RemoteObject | Cdp.Runtime.ObjectPreview | Cdp.Runtime.PropertyPreview,
): object is ObjectPreview.PreviewAsObjectType {
  return (
    object.type === 'function' ||
    (object.type === 'object' && !subtypesWithoutPreview.has(object.subtype))
  );
}

/**
 * Returns whether the given type should be previwed as an array.
 */
export function isArray(object: Cdp.Runtime.RemoteObject): object is ObjectPreview.ArrayObj;
export function isArray(object: ObjectPreview.AnyPreview): object is ObjectPreview.ArrayPreview;
export function isArray(
  object: Cdp.Runtime.RemoteObject | Cdp.Runtime.ObjectPreview | Cdp.Runtime.PropertyPreview,
): boolean {
  return object.subtype === 'array' || object.subtype === 'typedarray';
}

export function previewRemoteObject(
  object: Cdp.Runtime.RemoteObject,
  contextType?: string,
): string {
  const context = getContextForType(contextType);
  const result = previewRemoteObjectInternal(object as ObjectPreview.AnyObject, context);
  return context.postProcess?.(result) ?? result;
}

function previewRemoteObjectInternal(
  object: ObjectPreview.AnyObject,
  context: IPreviewContext,
): string {
  // Evaluating function does not produce preview object for it.
  if (object.type === 'function') {
    return formatFunctionDescription(object.description, context.budget);
  }

  if (object.type === 'object' && object.subtype === 'node') {
    return object.description;
  }

  return 'preview' in object && object.preview
    ? renderPreview(object.preview, context.budget)
    : renderValue(object, context.budget, context.quoted);
}

export function propertyWeight(prop: Cdp.Runtime.PropertyDescriptor): number {
  if (prop.name === '__proto__') return 0;
  return 100;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function privatePropertyWeight(_prop: Cdp.Runtime.PrivatePropertyDescriptor): number {
  return 20;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function internalPropertyWeight(_prop: Cdp.Runtime.InternalPropertyDescriptor): number {
  return 10;
}

function renderPreview(preview: ObjectPreview.AnyPreview, characterBudget: number): string {
  if (isArray(preview)) {
    return renderArrayPreview(preview, characterBudget);
  }

  if ((preview.subtype as string) === 'internal#entry') {
    return stringUtils.trimEnd(
      (preview as { description: string }).description || '',
      characterBudget,
    );
  }

  if (preview.type === 'function') {
    return formatFunctionDescription(preview.description, characterBudget);
  }

  if (previewAsObject(preview)) {
    return renderObjectPreview(preview, characterBudget);
  }

  return renderPrimitivePreview(preview, characterBudget);
}

function renderArrayPreview(preview: ObjectPreview.ArrayPreview, characterBudget: number): string {
  const builder = new BudgetStringBuilder(characterBudget);
  let description = preview.description;
  const match = description.match(/[^(]*\(([\d]+)\)/);
  if (!match) return description;
  const arrayLength = parseInt(match[1], 10);

  if (description.startsWith('Array(')) description = description.substring('Array'.length);
  builder.append(stringUtils.trimEnd(description, builder.budget()));
  builder.append(' ');
  const propsBuilder = new BudgetStringBuilder(builder.budget() - 2, ', '); // for []

  // Indexed
  let lastIndex = -1;
  for (const prop of preview.properties) {
    if (!propsBuilder.checkBudget()) break;
    if (isNaN((prop.name as unknown) as number)) continue;
    const index = parseInt(prop.name, 10);
    if (index > lastIndex + 1) propsBuilder.appendEllipsis();
    lastIndex = index;
    propsBuilder.append(renderPropertyPreview(prop, propsBuilder.budget()));
  }
  if (arrayLength > lastIndex + 1) propsBuilder.appendEllipsis();

  // Named
  for (const prop of preview.properties) {
    if (!propsBuilder.checkBudget()) break;
    if (!isNaN((prop.name as unknown) as number)) continue;
    propsBuilder.append(renderPropertyPreview(prop, propsBuilder.budget(), prop.name));
  }
  if (preview.overflow) propsBuilder.appendEllipsis();
  builder.append('[' + propsBuilder.build() + ']');
  return builder.build();
}

function renderObjectPreview(
  preview: ObjectPreview.ObjectPreview | ObjectPreview.NodePreview,
  characterBudget: number,
): string {
  const builder = new BudgetStringBuilder(characterBudget, ' ');
  if (preview.description !== 'Object')
    builder.append(stringUtils.trimEnd(preview.description, builder.budget()));

  const map = new Map<string, ObjectPreview.PropertyPreview>();
  const properties = preview.properties || [];
  for (const prop of properties) {
    map.set(prop.name, prop);
  }

  // Handle boxed values such as Number, String.
  const primitiveValue = map.get('[[PrimitiveValue]]');
  if (primitiveValue) {
    builder.append(`(${renderPropertyPreview(primitiveValue, builder.budget() - 2)})`);
    return builder.build();
  }

  // Promise handling.
  const promiseStatus = map.get('[[PromiseStatus]]');
  const promiseValue = map.get('[[PromiseValue]]');
  if (promiseStatus && promiseValue) {
    if (promiseStatus.value === 'pending') builder.append(`{<${promiseStatus.value}>}`);
    else
      builder.append(
        `{${renderPropertyPreview(
          promiseValue,
          builder.budget() - 2,
          `<${promiseStatus.value}>`,
        )}}`,
      );
    return builder.build();
  }

  // Generator handling.
  const generatorStatus = map.get('[[GeneratorStatus]]');
  if (generatorStatus) {
    builder.append(`{<${generatorStatus.value}>}`);
    return builder.build();
  }

  const propsBuilder = new BudgetStringBuilder(builder.budget() - 2, ', '); // for '{}'
  for (const prop of properties) {
    if (!propsBuilder.checkBudget()) break;
    propsBuilder.append(renderPropertyPreview(prop, propsBuilder.budget(), prop.name));
  }

  for (const entry of preview.entries || []) {
    if (!propsBuilder.checkBudget()) break;
    if (entry.key) {
      const key = renderPreview(entry.key, Math.min(maxEntryPreviewLength, propsBuilder.budget()));
      const value = renderPreview(
        entry.value,
        Math.min(maxEntryPreviewLength, propsBuilder.budget() - key.length - 4),
      );
      propsBuilder.append(appendKeyValue(key, ' => ', value, propsBuilder.budget()));
    } else {
      propsBuilder.append(
        renderPreview(entry.value, Math.min(maxEntryPreviewLength, propsBuilder.budget())),
      );
    }
  }

  const text = propsBuilder.build();
  if (text) {
    builder.append('{' + text + '}');
  } else if (builder.isEmpty()) {
    builder.append('{}');
  }

  return builder.build();
}

function valueOrEllipsis(value: string, characterBudget: number): string {
  return value.length <= characterBudget ? value : '…';
}

function truncateValue(value: string, characterBudget: number): string {
  return value.length >= characterBudget ? value.slice(0, characterBudget - 1) + '…' : value;
}

/**
 * Renders a preview of a primitive (number, undefined, null, string, etc) type.
 */
function renderPrimitivePreview(preview: ObjectPreview.Primitive, characterBudget: number): string {
  if (preview.type === 'object' && preview.subtype === 'null') {
    return valueOrEllipsis('null', characterBudget);
  }

  if (preview.type === 'undefined') {
    return valueOrEllipsis('undefined', characterBudget);
  }

  if (preview.type === 'string') {
    return stringUtils.trimMiddle(preview.description ?? preview.value, characterBudget);
  }

  return truncateValue(preview.description || '', characterBudget);
}

function appendKeyValue(
  key: string | undefined,
  separator: string,
  value: string,
  characterBudget: number,
) {
  if (key === undefined) return stringUtils.trimMiddle(value, characterBudget);
  if (key.length + separator.length > characterBudget)
    return stringUtils.trimEnd(key, characterBudget);
  return `${key}${separator}${stringUtils.trimMiddle(
    value,
    characterBudget - key.length - separator.length,
  )}`; // Keep in sync with characterBudget calculation.
}

function renderPropertyPreview(
  prop: ObjectPreview.PropertyPreview,
  characterBudget: number,
  name?: string,
): string {
  characterBudget = Math.min(characterBudget, maxPropertyPreviewLength);
  if (prop.type === 'function') return appendKeyValue(name, ': ', 'ƒ', characterBudget); // Functions don't carry preview.
  if (prop.type === 'object' && prop.value === 'Object')
    return appendKeyValue(name, ': ', '{\u2026}', characterBudget);
  if (typeof prop.value === 'undefined')
    return appendKeyValue(name, ': ', `<${prop.type}>`, characterBudget);
  if (prop.type === 'string') return appendKeyValue(name, ': ', `'${prop.value}'`, characterBudget);
  return appendKeyValue(name, ': ', prop.value ?? 'unknown', characterBudget);
}

function renderValue(object: Cdp.Runtime.RemoteObject, budget: number, quote: boolean): string {
  if (object.type === 'string') {
    const value = stringUtils.trimMiddle(object.value, quote ? budget - 2 : budget);
    return quote ? `'${value}'` : value;
  }

  if (object.type === 'undefined') return 'undefined';

  if (object.subtype === 'null') return 'null';

  if (object.description) return stringUtils.trimEnd(object.description, Math.max(budget, 100000));

  return stringUtils.trimEnd(String(object.value), budget);
}

function formatFunctionDescription(description: string, characterBudget: number): string {
  const builder = new BudgetStringBuilder(characterBudget);
  const text = description
    .replace(/^function [gs]et /, 'function ')
    .replace(/^function [gs]et\(/, 'function(')
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
    if (classNameMatch) className = classNameMatch[0].trim() || '';
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
      abbreviation = text.substring(0, firstArrowIndex + 2) + ' {\u2026}';
    addToken('', text, abbreviation);
  } else {
    addToken('ƒ', text, nameAndArguments(text));
  }
  return builder.build();

  function nameAndArguments(contents: string): string {
    const startOfArgumentsIndex = contents.indexOf('(');
    const endOfArgumentsMatch = contents.match(/\)\s*{/);
    const endIndex = (endOfArgumentsMatch && endOfArgumentsMatch.index) || 0;
    if (startOfArgumentsIndex !== -1 && endOfArgumentsMatch && endIndex > startOfArgumentsIndex) {
      const name = contents.substring(0, startOfArgumentsIndex).trim() || '';
      const args = contents.substring(startOfArgumentsIndex, endIndex + 1);
      return name + args;
    }
    return '()';
  }

  function addToken(prefix: string, body: string, abbreviation: string) {
    if (!builder.checkBudget()) return;
    if (prefix.length) builder.append(prefix + ' ');
    body = body.trim();
    if (body.endsWith(' { [native code] }'))
      body = body.substring(0, body.length - ' { [native code] }'.length);
    if (builder.budget() >= body.length) builder.append(body);
    else builder.append(abbreviation.replace(/\n/g, ' '));
  }
}

export function previewException(
  exception: Cdp.Runtime.RemoteObject,
): { title: string; stackTrace?: string } {
  if (exception.type !== 'object')
    return { title: renderValue(exception, maxExceptionTitleLength, false) };
  const description = exception.description ?? exception.className ?? 'Error';
  const firstCallFrame = /^\s+at\s/m.exec(description);
  if (!firstCallFrame) {
    const lastLineBreak = description.lastIndexOf('\n');
    if (lastLineBreak === -1) return { title: description };
    return { title: description.substring(0, lastLineBreak) };
  }
  return {
    title: description.substring(0, firstCallFrame.index - 1),
    stackTrace: description.substring(firstCallFrame.index + 2),
  };
}

function formatAsNumber(
  param: ObjectPreview.Numeric,
  round: boolean,
  characterBudget: number,
): string {
  if (param.type === 'number') {
    return String(param.value);
  }

  if (param.type === 'bigint') {
    return param.description;
  }

  const fallback = param as Cdp.Runtime.RemoteObject;
  const value = typeof fallback.value === 'number' ? fallback.value : +String(fallback.description);
  return stringUtils.trimEnd(String(round ? Math.floor(value) : value), characterBudget);
}

function formatAsString(param: Cdp.Runtime.RemoteObject, characterBudget: number): string {
  return stringUtils.trimMiddle(
    String(typeof param.value !== 'undefined' ? param.value : param.description),
    characterBudget,
  );
}

export function formatAsTable(param: Cdp.Runtime.ObjectPreview): string {
  // Collect columns, values and measure lengths.
  const rows: Map<string | undefined, string>[] = [];
  const colNames = new Set<string | undefined>([undefined]);
  const colLengths = new Map<string | undefined, number>();

  // Measure entries.
  for (const row of param.properties.filter(r => r.valuePreview)) {
    const value = new Map<string | undefined, string>();
    value.set(undefined, row.name); // row index is a first column
    colLengths.set(undefined, Math.max(colLengths.get(undefined) || 0, row.name.length));

    rows.push(value);
    row.valuePreview?.properties.map(prop => {
      if (!prop.value) return;
      colNames.add(prop.name);
      value.set(prop.name, prop.value);
      colLengths.set(prop.name, Math.max(colLengths.get(prop.name) || 0, prop.value.length));
    });
  }

  // Measure headers.
  for (const name of colNames.values()) {
    if (name) colLengths.set(name, Math.max(colLengths.get(name) || 0, name.length));
  }

  // Shrink columns if necessary.
  const columnsWidth = Array.from(colLengths.values()).reduce((a, c) => a + c, 0);
  const maxColumnsWidth = maxTableWidth - 4 - (colNames.size - 1) * 3;
  if (columnsWidth > maxColumnsWidth) {
    const ratio = maxColumnsWidth / columnsWidth;
    for (const name of colLengths.keys()) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const newWidth = Math.max(minTableCellWidth, (colLengths.get(name)! * ratio) | 0);
      colLengths.set(name, newWidth);
    }
  }

  // Template string for line separators.
  const colTemplates: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  for (const name of colNames.values()) colTemplates.push('-'.repeat(colLengths.get(name)!));
  const rowTemplate = '[-' + colTemplates.join('-|-') + '-]';

  const table: string[] = [];
  table.push(
    rowTemplate.replace('[', '╭').replace(/\|/g, '┬').replace(']', '╮').replace(/-/g, '┄'),
  );
  const header: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  for (const name of colNames.values()) header.push(pad(name || '', colLengths.get(name)!));
  table.push('┊ ' + header.join(' ┊ ') + ' ┊');
  table.push(
    rowTemplate.replace('[', '├').replace(/\|/g, '┼').replace(']', '┤').replace(/-/g, '┄'),
  );

  for (const value of rows) {
    const row: string[] = [];
    for (const colName of colNames.values()) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      row.push(pad(value.get(colName) || '', colLengths.get(colName)!));
    }
    table.push('┊ ' + row.join(' ┊ ') + ' ┊');
  }
  table.push(
    rowTemplate.replace('[', '╰').replace(/\|/g, '┴').replace(']', '╯').replace(/-/g, '┄'),
  );
  return table.map(row => stringUtils.trimEnd(row, maxTableWidth)).join('\n');
}

export const messageFormatters: messageFormat.Formatters<ObjectPreview.AnyObject> = new Map([
  ['', (param, context) => previewRemoteObjectInternal(param, context)],
  ['s', (param, context) => formatAsString(param, context.budget)],
  ['i', (param, context) => formatAsNumber(param as ObjectPreview.Numeric, true, context.budget)],
  ['d', (param, context) => formatAsNumber(param as ObjectPreview.Numeric, true, context.budget)],
  ['f', (param, context) => formatAsNumber(param as ObjectPreview.Numeric, false, context.budget)],
  ['c', param => messageFormat.formatCssAsAnsi((param as { value: string }).value)],
  ['o', (param, context) => previewRemoteObjectInternal(param, context)],
  ['O', (param, context) => previewRemoteObjectInternal(param, context)],
]);

function pad(text: string, length: number) {
  if (text.length === length) return text;
  if (text.length < length) return text + ' '.repeat(length - text.length);
  return stringUtils.trimEnd(text, length);
}
