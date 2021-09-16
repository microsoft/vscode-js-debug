/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

/* eslint-disable @typescript-eslint/no-unused-vars */

export const bootloaderLogger = {
  enabled: false,
  info: (...args: unknown[]) => {
    if (bootloaderLogger.enabled) {
      console.log(...args);
    }
  },
};
