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
      domain: 'NodeTracing',
      experimental: true,
      types: [
        {
          id: 'TraceConfig',
          type: 'object',
          properties: [
            {
              name: 'recordMode',
              description: 'Controls how the trace buffer stores data.',
              optional: true,
              type: 'string',
              enum: ['recordUntilFull', 'recordContinuously', 'recordAsMuchAsPossible'],
            },
            {
              name: 'includedCategories',
              description: 'Included category filters.',
              type: 'array',
              items: {
                type: 'string',
              },
            },
          ],
        },
      ],
      commands: [
        {
          name: 'getCategories',
          description: 'Gets supported tracing categories.',
          returns: [
            {
              name: 'categories',
              description: 'A list of supported tracing categories.',
              type: 'array',
              items: {
                type: 'string',
              },
            },
          ],
        },
        {
          name: 'start',
          description: 'Start trace events collection.',
          parameters: [
            {
              name: 'traceConfig',
              $ref: 'TraceConfig',
            },
          ],
        },
        {
          name: 'stop',
          description:
            'Stop trace events collection. Remaining collected events will be sent as a sequence of\ndataCollected events followed by tracingComplete event.',
        },
      ],
      events: [
        {
          name: 'dataCollected',
          description: 'Contains an bucket of collected trace events.',
          parameters: [
            {
              name: 'value',
              type: 'array',
              items: {
                type: 'object',
              },
            },
          ],
        },
        {
          name: 'tracingComplete',
          description:
            'Signals that tracing is stopped and there is no trace buffers pending flush, all data were\ndelivered via dataCollected events.',
        },
      ],
    },
    {
      domain: 'NodeWorker',
      description: 'Support for sending messages to Node worker Inspector instances.',
      experimental: true,
      types: [
        {
          id: 'WorkerID',
          type: 'string',
        },
        {
          id: 'SessionID',
          description: 'Unique identifier of attached debugging session.',
          type: 'string',
        },
        {
          id: 'WorkerInfo',
          type: 'object',
          properties: [
            {
              name: 'workerId',
              $ref: 'WorkerID',
            },
            {
              name: 'type',
              type: 'string',
            },
            {
              name: 'title',
              type: 'string',
            },
            {
              name: 'url',
              type: 'string',
            },
          ],
        },
      ],
      commands: [
        {
          name: 'sendMessageToWorker',
          description: 'Sends protocol message over session with given id.',
          parameters: [
            {
              name: 'message',
              type: 'string',
            },
            {
              name: 'sessionId',
              description: 'Identifier of the session.',
              $ref: 'SessionID',
            },
          ],
        },
        {
          name: 'enable',
          description:
            'Instructs the inspector to attach to running workers. Will also attach to new workers\nas they start',
          parameters: [
            {
              name: 'waitForDebuggerOnStart',
              description:
                'Whether to new workers should be paused until the frontend sends `Runtime.runIfWaitingForDebugger`\nmessage to run them.',
              type: 'boolean',
            },
          ],
        },
        {
          name: 'disable',
          description:
            'Detaches from all running workers and disables attaching to new workers as they are started.',
        },
        {
          name: 'detach',
          description: 'Detached from the worker with given sessionId.',
          parameters: [
            {
              name: 'sessionId',
              $ref: 'SessionID',
            },
          ],
        },
      ],
      events: [
        {
          name: 'attachedToWorker',
          description: 'Issued when attached to a worker.',
          parameters: [
            {
              name: 'sessionId',
              description: 'Identifier assigned to the session used to send/receive messages.',
              $ref: 'SessionID',
            },
            {
              name: 'workerInfo',
              $ref: 'WorkerInfo',
            },
            {
              name: 'waitingForDebugger',
              type: 'boolean',
            },
          ],
        },
        {
          name: 'detachedFromWorker',
          description: 'Issued when detached from the worker.',
          parameters: [
            {
              name: 'sessionId',
              description: 'Detached session identifier.',
              $ref: 'SessionID',
            },
          ],
        },
        {
          name: 'receivedMessageFromWorker',
          description:
            'Notifies about a new protocol message received from the session\n(session ID is provided in attachedToWorker notification).',
          parameters: [
            {
              name: 'sessionId',
              description: 'Identifier of a session which sends a message.',
              $ref: 'SessionID',
            },
            {
              name: 'message',
              type: 'string',
            },
          ],
        },
      ],
    },
    {
      domain: 'NodeRuntime',
      description: 'Support for inspecting node process state.',
      experimental: true,
      commands: [
        {
          name: 'notifyWhenWaitingForDisconnect',
          description: 'Enable the `NodeRuntime.waitingForDisconnect`.',
          parameters: [
            {
              name: 'enabled',
              type: 'boolean',
            },
          ],
        },
      ],
      events: [
        {
          name: 'waitingForDisconnect',
          description:
            'This event is fired instead of `Runtime.executionContextDestroyed` when\nenabled.\nIt is fired when the Node process finished all code execution and is\nwaiting for all frontends to disconnect.',
        },
      ],
    },
  ],
};
