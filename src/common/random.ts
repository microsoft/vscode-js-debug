/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

/**
 * Creates a random integer in the range [min, max)
 */
export const randomInRange = (min: number, max: number) =>
  min + Math.floor(Math.random() * (max - min));
