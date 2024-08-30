/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import Cdp from '../cdp/api';

/**
 * Network events mirrored over DAP.
 */
export interface IMirroredNetworkEvents {
  requestWillBeSent: Cdp.Network.RequestWillBeSentEvent;
  responseReceived: Cdp.Network.ResponseReceivedEvent;
  responseReceivedExtraInfo: Cdp.Network.ResponseReceivedExtraInfoEvent;
  loadingFailed: Cdp.Network.LoadingFailedEvent;
  loadingFinished: Cdp.Network.LoadingFinishedEvent;
}

export const mirroredNetworkEvents = Object.keys(
  {
    requestWillBeSent: 0,
    responseReceived: 0,
    responseReceivedExtraInfo: 0,
    loadingFailed: 0,
    loadingFinished: 0,
  } satisfies { [K in keyof IMirroredNetworkEvents]: unknown },
);
