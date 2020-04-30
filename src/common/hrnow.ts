/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

const nsPerSecond = 1e9;

/**
 * High-res time wrapper. Needed since process.hrtime.bigint()
 * is not available on Node < 12
 */
export class HrTime {
  public get ms() {
    return this.s * 1000;
  }

  public get s() {
    return this.value[0] + this.value[1] / nsPerSecond;
  }

  constructor(private readonly value = process.hrtime()) {}

  /**
   * Gets the time elapsed since the given time.
   */
  public elapsed() {
    return new HrTime().subtract(this);
  }

  /**
   * Subtracts the other time from this time.
   */
  public subtract(other: HrTime) {
    let ns = this.value[1] - other.value[1];
    let s = this.value[0] - other.value[0];
    if (ns < 0) {
      ns += nsPerSecond;
      s--;
    }

    return new HrTime([s, ns]);
  }
}
