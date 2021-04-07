/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

export default {
  version: {
    major: '1',
    minor: '0',
  },
  domains: [
    {
      domain: 'JsDebug',
      experimental: true,
      commands: [
        {
          name: 'subscribe',
          description:
            'Subscribes to the given CDP event(s). Events will not be sent through the\nconnection unless you subscribe to them',
          parameters: [
            {
              name: 'events',
              description:
                'List of events to subscribe to. Supports wildcards, for example\nyou can subscribe to `Debugger.scriptParsed` or `Debugger.*`',
              type: 'array',
              items: {
                type: 'string',
              },
            },
          ],
        },
      ],
    },
  ],
};
