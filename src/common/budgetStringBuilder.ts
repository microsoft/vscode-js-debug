/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

export class BudgetStringBuilder {
  private _tokens: string[] = [];
  private _budget: number;
  private _separator: string;

  constructor(budget: number, join?: string) {
    this._separator = join || '';
    this._budget = budget - 1 - this._separator.length; // Space for ellipsis.
  }

  append(text: string) {
    if (text.length > this.budget()) {
      this.appendEllipsis();
      return;
    }
    this._append(text);
  }

  private _append(text: string) {
    if (this._tokens.length) this._budget -= this._separator.length;
    this._tokens.push(text);
    this._budget -= text.length;
  }

  appendEllipsis() {
    if (this._tokens[this._tokens.length - 1] !== '…') this._append('…');
  }

  checkBudget(): boolean {
    if (this._budget <= 0) this.appendEllipsis();
    return this._budget > 0;
  }

  budget(): number {
    return this._budget - (this._tokens.length ? this._separator.length : 0);
  }

  build(): string {
    return this._tokens.join(this._separator);
  }

  isEmpty(): boolean {
    return !this._tokens.length;
  }
}
