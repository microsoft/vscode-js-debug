/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { EOL } from 'os';
import Dap from '../../dap/api';
/**
 * The ETX character is used to signal the end of a record.
 *
 * This stream tracker will look out for ETX characters in the stream. If it finds any, it will
 * switch from splitting the stream on newlines to splitting on ETX characters.
 */
const ETX = '\u0003';
const ETX_REGEX = /\u0003/g;

/**
 * The `std*` stream tracker monitors `stdout` or `stderr` for data and, periodically, sends it to the DAP.
 *
 * By default, the tracker will consume data from the stream and only send it to DAP when a newline is found.
 *
 * If, at any point, the tracker finds an ETX character, it will switch to sending data to DAP when an ETX character is found.
 * This allows multiline log entries to be handled more gracefully.
 */
export class StdStreamTracker {
  private streamName: 'stdout' | 'stderr';
  private cache = '';
  private etxSpotted = false;
  private dap: Dap.Api;

  constructor(streamName: 'stdout' | 'stderr', dap: Dap.Api) {
    this.streamName = streamName;
    this.dap = dap;
  }

  /**
   * This will be used as an event handler, so using the arrow function syntax to bind `this`.
   */
  consumeStdStreamData = (data: string | Buffer) => {
    const newData = data.toString();
    if (!this.etxSpotted) {
      this.etxSpotted = ETX_REGEX.test(newData);
    }
    this.cache += newData;
    this.flushCache();
  };

  /**
   * Searches for a complete entry in the cache, and if it finds one, sends it to the DAP.
   *
   * If it finds one, it will remove it from the cache and then flush the cache again.
   *
   */
  private flushCache() {
    const endOfEntryMarker = this.etxSpotted ? ETX : EOL;
    const index = this.cache.indexOf(endOfEntryMarker);
    if (index >= 0) {
      const entry = this.cache.slice(0, index);
      this.cache = this.cache.slice(index + 1);
      this.dap.output({ category: this.streamName, output: entry });
      this.flushCache();
    }
  }
}
