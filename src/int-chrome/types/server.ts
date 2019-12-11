/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import * as http from 'http';
import * as https from 'https';

export type HttpOrHttpsServer = http.Server | https.Server;
