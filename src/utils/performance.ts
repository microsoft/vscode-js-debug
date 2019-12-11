/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

export type HighResolutionTime = [number, number];

export function calculateElapsedTime(startProcessingTime: HighResolutionTime): number {
  const NanoSecondsPerMillisecond = 1000000;
  const NanoSecondsPerSecond = 1e9;

  const ellapsedTime = process.hrtime(startProcessingTime);
  const ellapsedMilliseconds =
    (ellapsedTime[0] * NanoSecondsPerSecond + ellapsedTime[1]) / NanoSecondsPerMillisecond;
  return ellapsedMilliseconds;
}
