// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/** Remove the whitespaces from the start of each line and any comments we find at the end */
export function trimWhitespaceAndComments(printedTestInput: string): string {
  return printedTestInput.replace(/^\s+/gm, '').replace(/ ?\/\/.*$/gm, ''); // Remove the white space we put at the start of the lines to make the printed test input align with the code
}
