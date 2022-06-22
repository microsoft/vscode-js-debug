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
          properties: [
            {
              name: 'name',
              description: 'Name of the debugger property.',
              type: 'string',
            },
            {
              name: 'value',
              description: 'Value of the property.',
              type: 'any',
            },
          ],
        },
      ],
      commands: [
        {
          name: 'setDebuggerProperty',
          description: 'Sets debugger properties.',
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
