// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

export interface FormatToken {
  type: string;
  value?: string;
  specifier?: string;
  precision?: number;
  substitutionIndex?: number;
}

export type Formatters<T> = Map<string, (a: T) => string>;

function tokenizeFormatString(format: string, formatterNames: string[]): FormatToken[] {
  const tokens: FormatToken[] = [];

  function addStringToken(str: string) {
    if (!str)
      return;
    if (tokens.length && tokens[tokens.length - 1].type === 'string')
      tokens[tokens.length - 1].value += str;
    else
      tokens.push({type: 'string', value: str});
  }

  function addSpecifierToken(specifier: string, precision: number | undefined, substitutionIndex: number) {
    tokens.push({type: 'specifier', specifier: specifier, precision: precision, substitutionIndex});
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
      const [_, substitionString, precisionString, specifierString] = match;
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
  const result: string[] = [];
  const tokens = tokenizeFormatString(format, Array.from(formatters.keys()));
  const usedSubstitutionIndexes = new Set<number>();
  const defaultFormat = formatters.get('')!;

  for (let i = 0; i < tokens.length; ++i) {
    const token = tokens[i];
    if (token.type === 'string') {
      result.push(token.value!);
      continue;
    }

    const index = token.substitutionIndex!;
    if (index! >= substitutions.length) {
      // If there are not enough substitutions for the current substitutionIndex
      // just output the format specifier literally and move on.
      result.push('%' + (token.precision || '') + token.specifier);
      continue;
    }
    usedSubstitutionIndexes.add(index);
    const format = formatters.get(token.specifier!) || defaultFormat;
    result.push(format(substitutions[index]));
  }

  result.push('\x1b[0m');

  for (let i = 0; i < substitutions.length; ++i) {
    if (usedSubstitutionIndexes.has(i))
      continue;
    const format = formatters.get('')!;
    result.push(defaultFormat(substitutions[i]));
  }

  return result.join(' ');
};
