// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

export interface IEquivalenceComparable {
  isEquivalentTo(right: this): boolean;
}
