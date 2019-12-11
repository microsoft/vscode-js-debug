/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

export interface Message {
  /**
   * Unique identifier for the message.
   */
  id: number;

  /**
   * A format string for the message. Embedded variables have the form '{name}'.
   * If variable name starts with an underscore character, the variable does not contain user data (PII) and can be safely used for telemetry purposes.
   */
  format: string;

  /**
   * An object used as a dictionary for looking up the variables in the format string.
   */
  variables?: { [key: string]: string };

  /**
   * If true send to telemetry.
   */
  sendTelemetry?: boolean;

  /**
   * If true show user.
   */
  showUser?: boolean;

  /**
   * An optional url where additional information about this message can be found.
   */
  url?: string;

  /**
   * An optional label that is presented to the user as the UI for opening the url.
   */
  urlLabel?: string;
}

export interface Error {
  __errorMarker: boolean;
  error: Message;
}
