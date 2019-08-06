// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

export interface UIDelegate {
  copyToClipboard: (text: string) => void;
  localize(key: string, message: string, ...args: (string | number | boolean | undefined | null)[]): string;
}
