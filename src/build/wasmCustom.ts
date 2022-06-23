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
      domain: 'DotnetDebugger',
      experimental: true,
      types: [
        {
          id: 'SetDebuggerPropertyParams',
          type: 'object',
          description:
            'Arguments for "setDebuggerProperty" request. Properties are determined by debugger.',
        },
      ],
      commands: [
        {
          name: 'setDebuggerProperty',
          description: 'Sets a debugger property.',
          parameters: [
            {
              name: 'params',
              $ref: 'SetDebuggerPropertyParams',
            },
          ],
        },
      ],
    },
  ],
};
