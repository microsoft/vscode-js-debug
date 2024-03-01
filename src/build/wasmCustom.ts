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
        {
          id: 'EvaluationOptions',
          type: 'object',
          description: 'Options that will be used to evaluate or to get variables.',
        },
        {
          id: 'SetSymbolOptionsParams',
          type: 'object',
          description:
            'Arguments for "setSymbolOptions" request. Properties are determined by debugger.',
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
        {
          name: 'setEvaluationOptions',
          description: 'Set options for evaluation',
          parameters: [
            {
              name: 'options',
              $ref: 'EvaluationOptions',
            },
            {
              name: 'type',
              type: 'string',
            },
          ],
        },
        {
          name: 'setSymbolOptions',
          description: 'Sets options for locating symbols.',
        },
      ],
      events: [
        {
          name: 'reportBlazorDebugError',
          description:
            'Fired when the attached Blazor DotnetDebugger itself, not the blazor app being debugged, encounters an error.',
          parameters: [
            {
              name: 'exceptionType',
              description: 'Specifies the type of exception.',
              type: 'string',
              enum: ['uncaughtException', 'unhandledRejection'],
            },
            {
              name: 'error',
              description: 'The error message.',
              type: 'string',
              enum: ['unknown', 'undefined'],
            },
          ],
        },
      ],
    },
  ],
};
