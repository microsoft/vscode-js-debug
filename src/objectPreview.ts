/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import Protocol from 'devtools-protocol';

export function previewRemoteObject(object: Protocol.Runtime.RemoteObject, context?: string): string {
  // Evaluating function does not produce preview object for it.
  if (object.type === 'function')
    return formatFunctionDescription(object.description);
  return object.preview ? renderPreview(object.preview, context) : renderValue(object);
}

export function briefPreviewRemoteObject(object: Protocol.Runtime.RemoteObject, context?: string): string {
  // Evaluating function does not produce preview object for it.
  if (object.type === 'function')
    return formatFunctionDescription(object.description);
  return object.description;
}

export function propertyWeight(prop: Protocol.Runtime.PropertyDescriptor): number {
  if (prop.name === '__proto__')
    return 0;
  return 100;
}

export function privatePropertyWeight(prop: Protocol.Runtime.PrivatePropertyDescriptor): number {
  return 20;
}

export function internalPropertyWeight(prop: Protocol.Runtime.InternalPropertyDescriptor): number {
  return 10;
}

function renderPreview(preview: Protocol.Runtime.ObjectPreview, context?: string): string {
  if (preview.subtype === 'array')
    return renderArrayPreview(preview, context);
  if (preview.subtype as string === 'internal#entry')
    return preview.description;
  if (preview.type === 'object')
    return renderObjectPreview(preview, context);
  if (preview.type === 'function')
    return formatFunctionDescription(preview.description);
  return renderPrimitivePreview(preview, context);
}

function renderArrayPreview(preview: Protocol.Runtime.ObjectPreview, context?: string): string {
  const tokens = [];
  const tokenBudget = context === 'repl' ? 8 : 3;
  let overflow = false;

  // Indexed
  let lastIndex = -1;
  for (const prop of preview.properties) {
    if (tokens.length > tokenBudget) {
      overflow = true;
      continue;
    }
    if (isNaN(prop.name as unknown as number))
      continue;
    const index = parseInt(prop.name, 10);
    if (index > lastIndex + 1)
      tokens.push('…');
    lastIndex = index;
    tokens.push(renderPropertyPreview(prop));
  }

  // Named
  for (const prop of preview.properties) {
    if (tokens.length > tokenBudget) {
      overflow = true;
      continue;
    }
    if (!isNaN(prop.name as unknown as number))
      continue;
    tokens.push(`${prop.name}: ${renderPropertyPreview(prop)}`);
  }

  if (overflow)
    tokens.push('…');

  return `${preview.description} [${tokens.join(', ')}]`;
}

function renderObjectPreview(preview: Protocol.Runtime.ObjectPreview, context?: string): string {
  const description = preview.description === 'Object' ? '' : preview.description + ' ';
  const tokens = [];
  const tokenBudget = context === 'repl' ? 8 : 3;
  let overflow = false;

  for (const prop of preview.properties) {
    if (tokens.length > tokenBudget) {
      overflow = true;
      continue;
    }
    tokens.push(`${prop.name}: ${renderPropertyPreview(prop)}`);
  }

  for (const entry of (preview.entries || [])) {
    if (tokens.length > tokenBudget) {
      overflow = true;
      continue;
    }
    tokens.push(`${renderPreview(entry.key)} => ${renderPreview(entry.value)}`);
  }

  if (overflow)
    tokens.push('…');

  return `${description}{${tokens.join(', ')}}`;
}

function renderPrimitivePreview(preview: Protocol.Runtime.ObjectPreview, context?: string): string {
  if (preview.subtype === 'null')
    return 'null';
    if (preview.type === 'undefined')
    return 'undefined';
  return preview.description;
}

function renderPropertyPreview(prop: Protocol.Runtime.PropertyPreview): string {
  if (prop.type === 'function')
    return 'ƒ';
  if (prop.type === 'object')
    return '{…}';
  const value = typeof prop.value === 'undefined' ? `<${prop.type}>` : trimEnd(prop.value, 50);
  return prop.type === 'string' ? `"${value}"` : value;
}

function renderValue(object: Protocol.Runtime.RemoteObject): string {
  if (object.value)
    return object.type === 'string' ? `'${object.value}'` : String(object.value);
  return object.description;
}

function trimEnd(text: string, maxLength: number) {
  if (text.length <= maxLength)
    return text;
  return text.substr(0, maxLength - 1) + '…';
}

function formatFunctionDescription(description: string, includePreview: boolean = false, defaultName: string = ''): string {
  const tokens = [];
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

  let textAfterPrefix;
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
    const maxArrowFunctionCharacterLength = 60;
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

  /**
   * @param {string} contents
   * @return {string}
   */
  function nameAndArguments(contents: string): string {
    const startOfArgumentsIndex = contents.indexOf('(');
    const endOfArgumentsMatch = contents.match(/\)\s*{/);
    if (startOfArgumentsIndex !== -1 && endOfArgumentsMatch && endOfArgumentsMatch.index > startOfArgumentsIndex) {
      const name = contents.substring(0, startOfArgumentsIndex).trim() || defaultName;
      const args = contents.substring(startOfArgumentsIndex, endOfArgumentsMatch.index + 1);
      return name + args;
    }
    return defaultName + '()';
  }

  /**
   * @param {string} prefix
   * @param {string} body
   * @param {string} abbreviation
   */
  function addToken(prefix: string, body: string, abbreviation: string) {
    const maxFunctionBodyLength = 200;
    if (prefix.length)
      tokens.push(prefix + ' ');
    if (includePreview)
      tokens.push(trimEnd(body.trim(), maxFunctionBodyLength));
    else
      tokens.push(abbreviation.replace(/\n/g, ' '));
  }
}
