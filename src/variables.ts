// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import Protocol from 'devtools-protocol';

export function generateArrayPreview(object: Protocol.Runtime.RemoteObject, context?: string): string {
  if (!object.preview)
    return object.description;

  const tokens = [];
  const tokenBudget = context === 'repl' ? 8 : 3;
  let overflow = false;

  // Indexed
  let lastIndex = -1;
  for (const prop of object.preview.properties) {
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
    tokens.push(generatePropertyValuePreview(prop));
  }

  // Named
  for (const prop of object.preview.properties) {
    if (tokens.length > tokenBudget) {
      overflow = true;
      continue;
    }
    if (!isNaN(prop.name as unknown as number))
      continue;
    tokens.push(`${prop.name}: ${generatePropertyValuePreview(prop)}`);
  }

  if (overflow)
    tokens.push('…');

  return `${object.description} [${tokens.join(', ')}]`;
}

export function generateObjectPreview(object: Protocol.Runtime.RemoteObject, context?: string): string {
  if (object.type === 'function')
    return formatFunctionDescription(object.description);

  const description = object.description === 'Object' ? '' : object.description + ' ';
  if (!object.preview)
    return description;

  const tokens = [];
  const tokenBudget = context === 'repl' ? 8 : 3;
  let overflow = false;

  for (const prop of object.preview.properties) {
    if (tokens.length > tokenBudget) {
      overflow = true;
      continue;
    }
    tokens.push(`${prop.name}: ${generatePropertyValuePreview(prop)}`);
  }

  if (overflow)
    tokens.push('…');

  return `${description}{${tokens.join(', ')}}`;
}

export function generatePrimitivePreview(object: Protocol.Runtime.RemoteObject, context?: string): string {
  if (object.subtype === 'null')
    return 'null';
    if (object.type === 'undefined')
    return 'undefined';
  return object.description;
}

function generatePropertyValuePreview(prop: Protocol.Runtime.PropertyPreview): string {
  if (prop.type === 'function')
    return 'ƒ';
  if (prop.type === 'object')
    return '{…}';
  const value = typeof prop.value === 'undefined' ? `<${prop.type}>` : trimEnd(prop.value, 50);
  return prop.type === 'string' ? `"${value}"` : value;
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
