/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { JSONSchema4 } from 'json-schema';

const dapCustom: JSONSchema4 = {
  definitions: {
    EnableCustomBreakpointsRequest: {
      allOf: [
        { $ref: '#/definitions/Request' },
        {
          type: 'object',
          description: 'Enable custom breakpoints.',
          properties: {
            command: {
              type: 'string',
              enum: ['enableCustomBreakpoints'],
            },
            arguments: {
              $ref: '#/definitions/EnableCustomBreakpointsArguments',
            },
          },
          required: ['command', 'arguments'],
        },
      ],
    },
    EnableCustomBreakpointsArguments: {
      type: 'object',
      description: "Arguments for 'enableCustomBreakpoints' request.",
      properties: {
        ids: {
          type: 'array',
          items: {
            type: 'string',
          },
          description: 'Id of breakpoints to enable.',
        },
      },
      required: ['ids'],
    },
    EnableCustomBreakpointsResponse: {
      allOf: [
        { $ref: '#/definitions/Response' },
        {
          type: 'object',
          description: "Response to 'enableCustomBreakpoints' request.",
        },
      ],
    },

    DisableCustomBreakpointsRequest: {
      allOf: [
        { $ref: '#/definitions/Request' },
        {
          type: 'object',
          description: 'Disable custom breakpoints.',
          properties: {
            command: {
              type: 'string',
              enum: ['disableCustomBreakpoints'],
            },
            arguments: {
              $ref: '#/definitions/DisableCustomBreakpointsArguments',
            },
          },
          required: ['command', 'arguments'],
        },
      ],
    },
    DisableCustomBreakpointsArguments: {
      type: 'object',
      description: "Arguments for 'disableCustomBreakpoints' request.",
      properties: {
        ids: {
          type: 'array',
          items: {
            type: 'string',
          },
          description: 'Id of breakpoints to disable.',
        },
      },
      required: ['ids'],
    },
    DisableCustomBreakpointsResponse: {
      allOf: [
        { $ref: '#/definitions/Response' },
        {
          type: 'object',
          description: "Response to 'disableCustomBreakpoints' request.",
        },
      ],
    },

    CanPrettyPrintSourceRequest: {
      allOf: [
        { $ref: '#/definitions/Request' },
        {
          type: 'object',
          description: 'Returns whether particular source can be pretty-printed.',
          properties: {
            command: {
              type: 'string',
              enum: ['canPrettyPrintSource'],
            },
            arguments: {
              $ref: '#/definitions/CanPrettyPrintSourceArguments',
            },
          },
          required: ['command', 'arguments'],
        },
      ],
    },
    CanPrettyPrintSourceArguments: {
      type: 'object',
      description: "Arguments for 'canPrettyPrintSource' request.",
      properties: {
        source: {
          $ref: '#/definitions/Source',
          description: 'Source to be pretty printed.',
        },
      },
      required: ['source'],
    },
    CanPrettyPrintSourceResponse: {
      allOf: [
        { $ref: '#/definitions/Response' },
        {
          type: 'object',
          description: "Response to 'canPrettyPrintSource' request.",
          properties: {
            body: {
              type: 'object',
              properties: {
                canPrettyPrint: {
                  type: 'boolean',
                  description: 'Whether source can be pretty printed.',
                },
              },
              required: ['canPrettyPrint'],
            },
          },
          required: ['body'],
        },
      ],
    },

    PrettyPrintSourceRequest: {
      allOf: [
        { $ref: '#/definitions/Request' },
        {
          type: 'object',
          description: 'Pretty prints source for debugging.',
          properties: {
            command: {
              type: 'string',
              enum: ['prettyPrintSource'],
            },
            arguments: {
              $ref: '#/definitions/PrettyPrintSourceArguments',
            },
          },
          required: ['command', 'arguments'],
        },
      ],
    },
    PrettyPrintSourceArguments: {
      type: 'object',
      description: "Arguments for 'prettyPrintSource' request.",
      properties: {
        source: {
          $ref: '#/definitions/Source',
          description: 'Source to be pretty printed.',
        },
        line: {
          type: 'integer',
          description:
            'Line number of currently selected location to reveal after pretty printing. If not present, nothing is revealed.',
        },
        column: {
          type: 'integer',
          description:
            'Column number of currently selected location to reveal after pretty printing.',
        },
      },
      required: ['source'],
    },
    PrettyPrintSourceResponse: {
      allOf: [
        { $ref: '#/definitions/Response' },
        {
          type: 'object',
          description: "Response to 'prettyPrintSource' request.",
        },
      ],
    },
    ToggleSkipFileStatusRequest: {
      allOf: [
        { $ref: '#/definitions/Request' },
        {
          type: 'object',
          description: 'Toggle skip status of file.',
          properties: {
            command: {
              type: 'string',
              enum: ['toggleSkipFileStatus'],
            },
            arguments: {
              $ref: '#/definitions/ToggleSkipFileStatusArguments',
            },
          },
          required: ['command', 'arguments'],
        },
      ],
    },
    ToggleSkipFileStatusArguments: {
      type: 'object',
      description: "Arguments for 'toggleSkipFileStatus' request.",
      properties: {
        resource: {
          type: 'string',
          description: 'Url of file to be skipped.',
        },
        sourceReference: {
          type: 'number',
          description: 'Source reference number of file.',
        },
      },
    },
    ToggleSkipFileStatusResponse: {
      allOf: [
        { $ref: '#/definitions/Response' },
        {
          type: 'object',
          description: "Response to 'toggleSkipFileStatus' request.",
        },
      ],
    },

    RevealLocationRequestedEvent: {
      allOf: [
        { $ref: '#/definitions/Event' },
        {
          type: 'object',
          description: 'A request to reveal a certain location in the UI.',
          properties: {
            event: {
              type: 'string',
              enum: ['revealLocationRequested'],
            },
            body: {
              type: 'object',
              properties: {
                source: {
                  $ref: '#/definitions/Source',
                  description: 'The source to reveal.',
                },
                line: {
                  type: 'integer',
                  description: 'The line number to reveal.',
                },
                column: {
                  type: 'integer',
                  description: 'The column number to reveal.',
                },
              },
              required: ['source'],
            },
          },
          required: ['event', 'body'],
        },
      ],
    },

    CopyRequestedEvent: {
      allOf: [
        { $ref: '#/definitions/Event' },
        {
          type: 'object',
          description: 'A request to copy a certain string to clipboard.',
          properties: {
            event: {
              type: 'string',
              enum: ['copyRequested'],
            },
            body: {
              type: 'object',
              properties: {
                text: {
                  type: 'string',
                  description: 'Text to copy.',
                },
              },
              required: ['text'],
            },
          },
          required: ['event', 'body'],
        },
      ],
    },

    LongPredictionEvent: {
      allOf: [
        { $ref: '#/definitions/Event' },
        {
          type: 'object',
          description:
            'An event sent when breakpoint prediction takes a significant amount of time.',
          properties: {
            event: {
              type: 'string',
              enum: ['longPrediction'],
            },
            body: {
              type: 'object',
              properties: {},
            },
          },
          required: ['event', 'body'],
        },
      ],
    },

    LaunchBrowserInCompanionEvent: {
      allOf: [
        { $ref: '#/definitions/Event' },
        {
          type: 'object',
          description: 'Enable custom breakpoints.',
          properties: {
            event: {
              type: 'string',
              enum: ['launchBrowserInCompanion'],
            },
            body: {
              type: 'object',
              description: "Body for 'LaunchBrowserInCompanion' request.",
              required: ['type', 'params', 'serverPort', 'launchId'],
              properties: {
                type: {
                  type: 'string',
                  enum: ['chrome', 'edge'],
                  description: 'Type of browser to launch',
                },
                launchId: {
                  type: 'number',
                  description: 'Incrementing ID to refer to this browser launch request',
                },
                serverPort: {
                  type: 'number',
                  description: 'Local port the debug server is listening on',
                },
                browserArgs: {
                  type: 'array',
                  items: {
                    type: 'string',
                  },
                },
                params: {
                  type: 'object',
                  description: 'Original launch parameters for the debug session',
                },
              },
            },
          },
          required: ['event', 'body'],
        },
      ],
    },

    KillCompanionBrowserEvent: {
      allOf: [
        { $ref: '#/definitions/Event' },
        {
          type: 'object',
          description: 'Enable custom breakpoints.',
          properties: {
            event: {
              type: 'string',
              enum: ['killCompanionBrowser'],
            },
            body: {
              type: 'object',
              description: "Body for 'KillCompanionBrowser' request.",
              required: ['launchId'],
              properties: {
                launchId: {
                  type: 'number',
                  description: 'Incrementing ID to refer to this browser launch request',
                },
              },
            },
          },
          required: ['event', 'body'],
        },
      ],
    },

    StartProfileRequest: {
      allOf: [
        { $ref: '#/definitions/Request' },
        {
          type: 'object',
          description: 'Starts taking a profile of the target.',
          properties: {
            command: {
              type: 'string',
              enum: ['startProfile'],
            },
            arguments: {
              $ref: '#/definitions/StartProfileArguments',
            },
          },
          required: ['command', 'arguments'],
        },
      ],
    },
    StartProfileArguments: {
      type: 'object',
      description: "Arguments for 'StartProfile' request.",
      properties: {
        stopAtBreakpoint: {
          type: 'array',
          items: {
            type: 'number',
          },
          description: 'Breakpoints where we should stop once hit.',
        },
        type: {
          type: 'string',
          description: 'Type of profile that should be taken',
        },
        params: {
          type: 'object',
          description: 'Additional arguments for the type of profiler',
        },
      },
      required: ['file', 'type'],
    },
    StartProfileResponse: {
      allOf: [
        { $ref: '#/definitions/Response' },
        {
          type: 'object',
          description: "Response to 'StartProfile' request.",
        },
      ],
    },

    StopProfileRequest: {
      allOf: [
        { $ref: '#/definitions/Request' },
        {
          type: 'object',
          description: 'Stops a running profile.',
          properties: {
            command: {
              type: 'string',
              enum: ['stopProfile'],
            },
            arguments: {
              $ref: '#/definitions/StopProfileArguments',
            },
          },
          required: ['command', 'arguments'],
        },
      ],
    },
    StopProfileArguments: {
      type: 'object',
      description: "Arguments for 'StopProfile' request.",
      properties: {},
    },
    StopProfileResponse: {
      allOf: [
        { $ref: '#/definitions/Response' },
        {
          type: 'object',
          description: "Response to 'StopProfile' request.",
        },
      ],
    },

    ProfileStartedEvent: {
      allOf: [
        { $ref: '#/definitions/Event' },
        {
          type: 'object',
          description: 'Fired when a profiling state changes.',
          properties: {
            event: {
              type: 'string',
              enum: ['profileStarted'],
            },
            body: {
              type: 'object',
              description: "Body for 'ProfilerStateUpdateEvent' event.",
              required: ['type', 'file'],
              properties: {
                type: {
                  type: 'string',
                  description: 'Type of running profile',
                },
                file: {
                  type: 'string',
                  description: 'Location where the profile is saved.',
                },
              },
            },
          },
          required: ['event', 'body'],
        },
      ],
    },
    ProfilerStateUpdateEvent: {
      allOf: [
        { $ref: '#/definitions/Event' },
        {
          type: 'object',
          description: 'Fired when a profiling state changes.',
          properties: {
            event: {
              type: 'string',
              enum: ['profilerStateUpdate'],
            },
            body: {
              type: 'object',
              description: "Body for 'ProfilerStateUpdateEvent' event.",
              required: ['label', 'running'],
              properties: {
                label: {
                  type: 'string',
                  description: 'Description of the current state',
                },
                running: {
                  type: 'boolean',
                  description: 'Set to false if the profile has now ended',
                },
              },
            },
          },
          required: ['event', 'body'],
        },
      ],
    },

    LaunchVSCodeRequest: {
      allOf: [
        { $ref: '#/definitions/Request' },
        {
          type: 'object',
          description: 'Launches a VS Code extension host in debug mode.',
          properties: {
            command: {
              type: 'string',
              enum: ['launchVSCode'],
            },
            arguments: {
              $ref: '#/definitions/LaunchVSCodeArguments',
            },
          },
          required: ['command', 'arguments'],
        },
      ],
    },
    LaunchVSCodeArguments: {
      type: 'object',
      description: "Arguments for 'LaunchVSCode' request.",
      required: ['args', 'env'],
      properties: {
        args: {
          type: 'array',
          items: {
            $ref: '#/definitions/LaunchVSCodeArgument',
          },
        },
        env: {
          type: 'object',
        },
      },
    },
    LaunchVSCodeArgument: {
      type: 'object',
      description:
        'This interface represents a single command line argument split into a "prefix" and a "path" half. The optional "prefix" contains arbitrary text and the optional "path" contains a file system path. Concatenating both results in the original command line argument.',
      properties: {
        path: {
          type: 'string',
        },
        prefix: {
          type: 'string',
        },
      },
    },
    LaunchVSCodeResponse: {
      allOf: [
        { $ref: '#/definitions/Response' },
        {
          type: 'object',
          description: "Response to 'LaunchVSCode' request.",
        },
      ],
    },

    LaunchUnelevatedRequest: {
      allOf: [
        { $ref: '#/definitions/Request' },
        {
          type: 'object',
          description: 'Launches Chrome unelevated, used in VS.',
          properties: {
            command: {
              type: 'string',
              enum: ['launchUnelevated'],
            },
            arguments: {
              $ref: '#/definitions/LaunchUnelevatedArguments',
            },
          },
          required: ['command', 'arguments'],
        },
      ],
    },
    LaunchUnelevatedArguments: {
      type: 'object',
      description: "Arguments for 'LaunchUnelevated' request.",
      properties: {
        process: {
          type: 'string',
        },
        args: {
          type: 'array',
          items: {
            type: 'string',
          },
        },
      },
    },
    LaunchUnelevatedResponse: {
      allOf: [
        { $ref: '#/definitions/Response' },
        {
          type: 'object',
          description: "Response to 'LaunchUnelevated' request.",
        },
      ],
    },

    GetBreakpointsRequest: {
      allOf: [
        { $ref: '#/definitions/Request' },
        {
          type: 'object',
          description: 'Gets all defined breakpoints.',
          properties: {
            command: {
              type: 'string',
              enum: ['getBreakpoints'],
            },
            arguments: {
              $ref: '#/definitions/GetBreakpointsArguments',
            },
          },
          required: ['command', 'arguments'],
        },
      ],
    },
    GetBreakpointsArguments: {
      type: 'object',
      description: "Arguments for 'GetBreakpoints' request.",
      properties: {},
    },
    GetBreakpointsResponse: {
      allOf: [
        { $ref: '#/definitions/Response' },
        {
          type: 'object',
          description: "Response to 'GetBreakpoints' request.",
          required: ['body'],
          properties: {
            body: {
              type: 'object',
              required: ['breakpoints'],
              properties: {
                breakpoints: {
                  type: 'array',
                  items: {
                    $ref: '#/definitions/Breakpoint',
                  },
                },
              },
            },
          },
        },
      ],
    },

    RevealPageRequest: {
      allOf: [
        { $ref: '#/definitions/Request' },
        {
          type: 'object',
          description: 'Gets all defined breakpoints.',
          properties: {
            command: {
              type: 'string',
              enum: ['revealPage'],
            },
            arguments: {
              $ref: '#/definitions/RevealPageArguments',
            },
          },
          required: ['command', 'arguments'],
        },
      ],
    },
    RevealPageArguments: {
      type: 'object',
      description: "Arguments for 'RevealPage' request.",
      properties: {},
    },
    RevealPageResponse: {
      allOf: [
        { $ref: '#/definitions/Response' },
        {
          type: 'object',
          description: "Response to 'RevealPage' request.",
          required: ['body'],
          properties: {
            body: {},
          },
        },
      ],
    },

    StartSelfProfileRequest: {
      allOf: [
        { $ref: '#/definitions/Request' },
        {
          type: 'object',
          description: 'Starts profiling the extension itself. Used by VS.',
          properties: {
            command: {
              type: 'string',
              enum: ['startSelfProfile'],
            },
            arguments: {
              $ref: '#/definitions/StartSelfProfileArguments',
            },
          },
          required: ['command', 'arguments'],
        },
      ],
    },
    StartSelfProfileArguments: {
      type: 'object',
      description: "Arguments for 'StartSelfProfile' request.",
      required: ['file'],
      properties: {
        file: {
          description: 'File where the profile should be saved',
          type: 'string',
        },
      },
    },
    StartSelfProfileResponse: {
      allOf: [
        { $ref: '#/definitions/Response' },
        {
          type: 'object',
          description: "Response to 'StartSelfProfile' request.",
        },
      ],
    },

    StopSelfProfileRequest: {
      allOf: [
        { $ref: '#/definitions/Request' },
        {
          type: 'object',
          description: 'Stops profiling the extension itself. Used by VS.',
          properties: {
            command: {
              type: 'string',
              enum: ['stopSelfProfile'],
            },
            arguments: {
              $ref: '#/definitions/StopSelfProfileArguments',
            },
          },
          required: ['command', 'arguments'],
        },
      ],
    },
    StopSelfProfileArguments: {
      type: 'object',
      description: "Arguments for 'StopSelfProfile' request.",
      properties: {},
    },
    StopSelfProfileResponse: {
      allOf: [
        { $ref: '#/definitions/Response' },
        {
          type: 'object',
          description: "Response to 'StopSelfProfile' request.",
        },
      ],
    },
  },
};

export default dapCustom;
