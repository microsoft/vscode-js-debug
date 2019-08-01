// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import Color from 'color';
import { BudgetStringBuilder } from '../utils/budgetStringBuilder';

export interface FormatToken {
  type: string;
  value?: string;
  specifier?: string;
  precision?: number;
  substitutionIndex?: number;
}

const maxMessageFormatLength = 10000;

export type Formatters<T> = Map<string, (a: T, characterBudget: number) => string>;

function tokenizeFormatString(format: string, formatterNames: string[]): FormatToken[] {
  const tokens: FormatToken[] = [];

  function addStringToken(str: string) {
    if (!str)
      return;
    if (tokens.length && tokens[tokens.length - 1].type === 'string')
      tokens[tokens.length - 1].value += str;
    else
      tokens.push({ type: 'string', value: str });
  }

  function addSpecifierToken(specifier: string, precision: number | undefined, substitutionIndex: number) {
    tokens.push({ type: 'specifier', specifier: specifier, precision: precision, substitutionIndex });
  }

  let textStart = 0;
  let substitutionIndex = 0;
  const re = new RegExp(`%%|%(?:(\\d+)\\$)?(?:\\.(\\d*))?([${formatterNames.join('')}])`, 'g');
  for (let match = re.exec(format); !!match; match = re.exec(format)) {
    const matchStart = match.index;
    if (matchStart > textStart)
      addStringToken(format.substring(textStart, matchStart));

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
};

export function formatMessage<T>(format: string, substitutions: any[], formatters: Formatters<T>): string {
  const tokens = tokenizeFormatString(format, Array.from(formatters.keys()));
  const usedSubstitutionIndexes = new Set<number>();
  const defaultFormatter = formatters.get('')!;
  const builder = new BudgetStringBuilder(maxMessageFormatLength);
  let cssFormatApplied = false;
  for (let i = 0; builder.hasBudget() && i < tokens.length; ++i) {
    const token = tokens[i];
    if (token.type === 'string') {
      builder.appendCanSkip(token.value!);
      continue;
    }

    const index = token.substitutionIndex!;
    if (index >= substitutions.length) {
      // If there are not enough substitutions for the current substitutionIndex
      // just output the format specifier literally and move on.
      builder.appendCanSkip('%' + (token.precision || '') + token.specifier);
      continue;
    }
    usedSubstitutionIndexes.add(index);
    if (token.specifier === 'c')
      cssFormatApplied = true;
    const formatter = formatters.get(token.specifier!) || defaultFormatter;
    builder.appendCanSkip(formatter(substitutions[index], builder.budget()));
  }

  if (cssFormatApplied)
    builder.appendCanSkip('\x1b[0m');  // clear format

  for (let i = 0; builder.hasBudget() && i < substitutions.length; ++i) {
    if (usedSubstitutionIndexes.has(i))
      continue;
    if (format || i)  // either we are second argument or we had format.
      builder.appendCanSkip(' ');
    builder.appendCanSkip(defaultFormatter(substitutions[i], builder.budget()));
  }

  return builder.build();
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
          if (color)
            escapedSequence += `\x1b[38;5;${color}m`;
          break;
        case 'background':
        case 'background-color':
          const background = escapeAnsiColor(match[2]);
          if (background)
            escapedSequence += `\x1b[48;5;${background}m`;
          break;
        case 'font-weight':
          if (match[2] === 'bold')
            escapedSequence += '\x1b[1m';
          break;
        case 'font-style':
          if (match[2] === 'italic')
            escapedSequence += '\x1b[3m';
          break;
        case 'text-decoration':
          if (match[2] === 'underline')
            escapedSequence += '\x1b[4m';
          break;
        default:
        // css not mapped, skip
      }
    }

    match = cssRegex.exec(style);
  }

  return escapedSequence;
}
