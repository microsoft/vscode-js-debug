/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import Color from 'color';
import { BudgetStringBuilder } from '../common/budgetStringBuilder';
import { IPreviewContext } from './objectPreview/contexts';

export type FormatToken =
  | { type: 'string'; value: string }
  | { type: 'specifier'; specifier: string; precision?: number; substitutionIndex: number };

const maxMessageFormatLength = 10000;

export type Formatters<T> = Map<string, (a: T, context: IPreviewContext) => string>;

function tokenizeFormatString(format: string, formatterNames: string[]): FormatToken[] {
  const tokens: FormatToken[] = [];

  function addStringToken(str: string) {
    if (!str) return;
    const lastToken = tokens[tokens.length - 1];
    if (lastToken?.type === 'string') lastToken.value += str;
    else tokens.push({ type: 'string', value: str });
  }

  function addSpecifierToken(
    specifier: string,
    precision: number | undefined,
    substitutionIndex: number,
  ) {
    tokens.push({
      type: 'specifier',
      specifier: specifier,
      precision: precision,
      substitutionIndex,
    });
  }

  let textStart = 0;
  let substitutionIndex = 0;
  const re = new RegExp(`%%|%(?:(\\d+)\\$)?(?:\\.(\\d*))?([${formatterNames.join('')}])`, 'g');
  for (let match = re.exec(format); !!match; match = re.exec(format)) {
    const matchStart = match.index;
    if (matchStart > textStart) addStringToken(format.substring(textStart, matchStart));

    if (match[0] === '%%') {
      addStringToken('%');
    } else {
      const [, substitionString, precisionString, specifierString] = match;
      if (substitionString && Number(substitionString) > 0)
        substitutionIndex = Number(substitionString) - 1;
      const precision = precisionString ? Number(precisionString) : undefined;
      addSpecifierToken(specifierString, precision, substitutionIndex);
      ++substitutionIndex;
    }
    textStart = matchStart + match[0].length;
  }
  addStringToken(format.substring(textStart));
  return tokens;
}

export function formatMessage<T>(
  format: string,
  substitutions: ReadonlyArray<T>,
  formatters: Formatters<T>,
): { result: string; usedAllSubs: boolean } {
  const tokens = tokenizeFormatString(format, Array.from(formatters.keys()));
  const usedSubstitutionIndexes = new Set<number>();
  const defaultFormatter = formatters.get('');
  if (!defaultFormatter) {
    throw new Error('Expected to hav a default formatter');
  }

  const builder = new BudgetStringBuilder(maxMessageFormatLength);
  let cssFormatApplied = false;
  for (let i = 0; builder.checkBudget() && i < tokens.length; ++i) {
    const token = tokens[i];
    if (token.type === 'string') {
      builder.append(token.value);
      continue;
    }

    const index = token.substitutionIndex;
    if (index >= substitutions.length) {
      // If there are not enough substitutions for the current substitutionIndex
      // just output the format specifier literally and move on.
      builder.append('%' + (token.precision || '') + token.specifier);
      continue;
    }
    usedSubstitutionIndexes.add(index);
    if (token.specifier === 'c') cssFormatApplied = true;
    const formatter = formatters.get(token.specifier) || defaultFormatter;
    builder.append(formatter(substitutions[index], { budget: builder.budget(), quoted: false }));
  }

  if (cssFormatApplied) builder.append('\x1b[0m'); // clear format

  for (let i = 0; builder.checkBudget() && i < substitutions.length; ++i) {
    if (usedSubstitutionIndexes.has(i)) continue;
    usedSubstitutionIndexes.add(i);
    if (format || i)
      // either we are second argument or we had format.
      builder.append(' ');
    builder.append(defaultFormatter(substitutions[i], { budget: builder.budget(), quoted: false }));
  }

  return {
    result: builder.build(),
    usedAllSubs: usedSubstitutionIndexes.size === substitutions.length,
  };
}

function escapeAnsiColor(colorString: string): number | undefined {
  try {
    // Color can parse hex and color names
    const color = new Color(colorString);
    return color.ansi256().object().ansi256;
  } catch (ex) {
    // Unable to parse Color
    // For instance, "inherit" color will throw
  }
  return undefined;
}

export function formatCssAsAnsi(style: string): string {
  const cssRegex = /\s*(.*?)\s*:\s*(.*?)\s*(?:;|$)/g;
  let escapedSequence = '\x1b[0m';
  let match = cssRegex.exec(style);
  while (match !== null) {
    if (match.length === 3) {
      switch (match[1]) {
        case 'color':
          const color = escapeAnsiColor(match[2]);
          if (color) escapedSequence += `\x1b[38;5;${color}m`;
          break;
        case 'background':
        case 'background-color':
          const background = escapeAnsiColor(match[2]);
          if (background) escapedSequence += `\x1b[48;5;${background}m`;
          break;
        case 'font-weight':
          if (match[2] === 'bold') escapedSequence += '\x1b[1m';
          break;
        case 'font-style':
          if (match[2] === 'italic') escapedSequence += '\x1b[3m';
          break;
        case 'text-decoration':
          if (match[2] === 'underline') escapedSequence += '\x1b[4m';
          break;
        default:
        // css not mapped, skip
      }
    }

    match = cssRegex.exec(style);
  }

  return escapedSequence;
}
