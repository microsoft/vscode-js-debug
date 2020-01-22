/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import { Contributions, IConfigurationTypes, Configuration } from '../common/contributionUtils';
import {
  IMandatedConfiguration,
  AnyLaunchConfiguration,
  ResolvingConfiguration,
  INodeAttachConfiguration,
  INodeBaseConfiguration,
  IBaseConfiguration,
  OutputSource,
  INodeLaunchConfiguration,
  IExtensionHostConfiguration,
  IChromeBaseConfiguration,
  IChromeLaunchConfiguration,
  IChromeAttachConfiguration,
  ITerminalLaunchConfiguration,
  baseDefaults,
} from '../configuration';
import { JSONSchema6 } from 'json-schema';
import strings from './strings';
import { walkObject, sortKeys } from '../common/objUtils';

type OmittedKeysFromAttributes =
  | keyof IMandatedConfiguration
  | 'rootPath'
  | '__workspaceFolder'
  | '__workspaceCachePath';

type DescribedAttribute<T> = JSONSchema6 &
  Described & {
    default: T;
    enum?: Array<T>;
  };

type ConfigurationAttributes<T> = {
  [K in keyof Omit<T, OmittedKeysFromAttributes>]: DescribedAttribute<T[K]>;
};
type Described =
  | { description: MappedReferenceString }
  | { enumDescriptions: MappedReferenceString[] }
  | { markdownDescription: MappedReferenceString };

/**
 * Opaque type for a string passed through refString, ensuring all templates
 * are defined as NLS strings.
 */
type MappedReferenceString = { __opaque: true } & string;

// eslint-disable-next-line
const refString = (str: keyof typeof strings): MappedReferenceString => `%${str}%` as any;

/**
 * Type definition for a debugger section. VSCode doesn't publish these types,
 * and we want to bind them more tightly to the types from the configuration anyway.
 */
interface IDebugger<T extends AnyLaunchConfiguration> {
  type: T['type'];
  request: T['request'];
  label: MappedReferenceString;
  program?: string;
  runtime?: string;
  variables?: { [key: string]: Contributions };
  required?: (keyof T)[];
  configurationSnippets: ({
    label: MappedReferenceString;
    body: ResolvingConfiguration<T & { preLaunchTask?: string }>;
  } & Described)[];
  configurationAttributes: ConfigurationAttributes<T>;
}

const baseConfigurationAttributes: ConfigurationAttributes<IBaseConfiguration> = {
  address: {
    type: 'string',
    description: refString('node.address.description'),
    default: 'localhost',
  },
  port: {
    type: 'number',
    description: refString('node.port.description'),
    default: 9229,
  },
  resolveSourceMapLocations: {
    type: ['array', 'null'],
    description: refString('node.resolveSourceMapLocations.description'),
    default: null,
    items: {
      type: 'string',
    },
  },
  outFiles: {
    type: ['array'],
    description: refString('outFiles.description'),
    default: baseDefaults.outFiles,
    items: {
      type: 'string',
    },
  },
  pauseForSourceMap: {
    type: 'boolean',
    markdownDescription: refString('node.pauseForSourceMap.description'),
    default: false,
  },
  showAsyncStacks: {
    description: refString('node.showAsyncStacks.description'),
    default: true,
    oneOf: [
      {
        type: 'boolean',
      },
      {
        type: 'object',
        required: ['onAttach'],
        properties: {
          onAttach: {
            type: 'number',
            default: 32,
          },
        },
      },
      {
        type: 'object',
        required: ['onceBreakpointResolved'],
        properties: {
          onceBreakpointResolved: {
            type: 'number',
            default: 32,
          },
        },
      },
    ],
  },
  skipFiles: {
    type: 'array',
    description: refString('chrome.skipFiles.description'),
    default: ['<node_internals>/**'],
  },
  smartStep: {
    type: 'boolean',
    description: refString('smartStep.description'),
    default: true,
  },
  sourceMaps: {
    type: 'boolean',
    description: refString('chrome.sourceMaps.description'),
    default: true,
  },
  sourceMapPathOverrides: {
    type: 'object',
    description: refString('node.sourceMapPathOverrides.description'),
    default: baseDefaults.sourceMapPathOverrides,
  },
  timeout: {
    type: 'number',
    description: refString('node.timeout.description'),
    default: 10000,
  },
  trace: {
    description: refString('trace.description'),
    default: true,
    oneOf: [
      {
        type: 'boolean',
        description: refString('trace.boolean.description'),
      },
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          console: {
            type: 'boolean',
            description: refString('trace.console.description'),
          },
          level: {
            enum: ['fatal', 'error', 'warn', 'info', 'verbose'],
            description: refString('trace.level.description'),
          },
          logFile: {
            type: ['string', 'null'],
            description: refString('trace.logFile.description'),
          },
          tags: {
            type: 'array',
            description: refString('trace.tags.description'),
            items: {
              enum: ['cdp', 'dap', 'runtime'],
            },
          },
        },
      },
    ],
  },
  outputCapture: {
    enum: [OutputSource.Console, OutputSource.Stdio],
    description: refString('node.launch.outputCapture.description'),
    default: OutputSource.Console,
  },
};

/**
 * Shared Node.js configuration.
 */
const nodeBaseConfigurationAttributes: ConfigurationAttributes<INodeBaseConfiguration> = {
  ...baseConfigurationAttributes,
  resolveSourceMapLocations: {
    ...baseConfigurationAttributes.resolveSourceMapLocations,
    default: ['${workspaceFolder}/**', '!**/node_modules/**'],
  },
  cwd: {
    type: 'string',
    description: refString('node.launch.cwd.description'),
    default: '${workspaceFolder}',
  },
  localRoot: {
    type: ['string', 'null'],
    description: refString('node.localRoot.description'),
    default: null,
  },
  remoteRoot: {
    type: ['string', 'null'],
    description: refString('node.remoteRoot.description'),
    default: null,
  },
  autoAttachChildProcesses: {
    type: 'boolean',
    description: refString('node.launch.autoAttachChildProcesses.description'),
    default: true,
  },
  env: {
    type: 'object',
    additionalProperties: {
      type: ['string', 'null'],
    },
    markdownDescription: refString('node.launch.env.description'),
    default: {},
  },
  envFile: {
    type: 'string',
    description: refString('node.launch.envFile.description'),
    default: '${workspaceFolder}/.env',
  },
};

/**
 * Node attach configuration.
 */
const nodeAttachConfig: IDebugger<INodeAttachConfiguration> = {
  type: Contributions.NodeDebugType,
  request: 'attach',
  label: refString('node.label'),
  variables: {
    PickProcess: Contributions.PickProcessCommand,
  },
  configurationSnippets: [
    {
      label: refString('node.snippet.attach.label'),
      description: refString('node.snippet.attach.description'),
      body: {
        type: Contributions.NodeDebugType,
        request: 'attach',
        name: '${1:Attach}',
        port: 9229,
        skipFiles: ['<node_internals>/**'],
      },
    },
    {
      label: refString('node.snippet.remoteattach.label'),
      description: refString('node.snippet.remoteattach.description'),
      body: {
        type: Contributions.NodeDebugType,
        request: 'attach',
        name: '${1:Attach to Remote}',
        address: '${2:TCP/IP address of process to be debugged}',
        port: 9229,
        localRoot: '^"\\${workspaceFolder}"',
        remoteRoot: '${3:Absolute path to the remote directory containing the program}',
        skipFiles: ['<node_internals>/**'],
      },
    },
    {
      label: refString('node.snippet.attachProcess.label'),
      description: refString('node.snippet.attachProcess.description'),
      body: {
        type: Contributions.NodeDebugType,
        request: 'attach',
        name: '${1:Attach by Process ID}',
        processId: '^"\\${command:PickProcess}"',
        skipFiles: ['<node_internals>/**'],
      },
    },
  ],
  configurationAttributes: {
    ...nodeBaseConfigurationAttributes,
    restart: {
      description: refString('node.attach.restart.description'),
      default: true,
      oneOf: [
        {
          type: 'boolean',
        },
        {
          type: 'object',
          required: ['exponential'],
          properties: {
            exponential: {
              type: 'object',
              properties: {
                maxDelay: { type: 'number', minimum: 0, default: 10000 },
                maxAttempts: { type: 'number', minimum: 0, default: 10 },
                exponent: { type: 'number', minimum: 1, default: 2 },
                initialDelay: { type: 'number', minimum: 0, default: 128 },
              },
            },
          },
        },
        {
          type: 'object',
          required: ['static'],
          properties: {
            static: {
              type: 'object',
              properties: {
                delay: { type: 'number', minimum: 0, default: 1000 },
                maxAttempts: { type: 'number', minimum: 0, default: 10 },
              },
            },
          },
        },
      ],
    },
    processId: {
      type: 'string',
      description: refString('node.attach.processId.description'),
      default: '${command:PickProcess}',
    },
    attachSpawnedProcesses: {
      type: 'boolean',
      description: refString('node.attach.attachSpawnedProcesses.description'),
      default: true,
    },
    attachExistingChildren: {
      type: 'boolean',
      description: refString('node.attach.attachExistingChildren.description'),
      default: false,
    },
  },
};

/**
 * Node attach configuration.
 */
const nodeLaunchConfig: IDebugger<INodeLaunchConfiguration> = {
  type: Contributions.NodeDebugType,
  request: 'launch',
  label: refString('node.label'),
  variables: {
    PickProcess: Contributions.PickProcessCommand,
  },
  configurationSnippets: [
    {
      label: refString('node.snippet.launch.label'),
      description: refString('node.snippet.launch.description'),
      body: {
        type: Contributions.NodeDebugType,
        request: 'launch',
        name: '${2:Launch Program}',
        program: '^"\\${workspaceFolder}/${1:app.js}"',
        skipFiles: ['<node_internals>/**'],
      },
    },
    {
      label: refString('node.snippet.npm.label'),
      markdownDescription: refString('node.snippet.npm.description'),
      body: {
        type: Contributions.NodeDebugType,
        request: 'launch',
        name: '${1:Launch via NPM}',
        runtimeExecutable: 'npm',
        runtimeArgs: ['run-script', 'debug'],
        port: 9229,
        skipFiles: ['<node_internals>/**'],
      },
    },
    {
      label: refString('node.snippet.nodemon.label'),
      description: refString('node.snippet.nodemon.description'),
      body: {
        type: Contributions.NodeDebugType,
        request: 'launch',
        name: 'nodemon',
        runtimeExecutable: 'nodemon',
        program: '^"\\${workspaceFolder}/${1:app.js}"',
        restart: true,
        console: 'integratedTerminal',
        internalConsoleOptions: 'neverOpen',
        skipFiles: ['<node_internals>/**'],
      },
    },
    {
      label: refString('node.snippet.mocha.label'),
      description: refString('node.snippet.mocha.description'),
      body: {
        type: Contributions.NodeDebugType,
        request: 'launch',
        name: 'Mocha Tests',
        program: '^"\\${workspaceFolder}/node_modules/mocha/bin/_mocha"',
        args: ['-u', 'tdd', '--timeout', '999999', '--colors', '^"\\${workspaceFolder}/${1:test}"'],
        internalConsoleOptions: 'openOnSessionStart',
        skipFiles: ['<node_internals>/**'],
      },
    },
    {
      label: refString('node.snippet.yo.label'),
      markdownDescription: refString('node.snippet.yo.description'),
      body: {
        type: Contributions.NodeDebugType,
        request: 'launch',
        name: 'Yeoman ${1:generator}',
        program: '^"\\${workspaceFolder}/node_modules/yo/lib/cli.js"',
        args: ['${1:generator}'],
        console: 'integratedTerminal',
        internalConsoleOptions: 'neverOpen',
        skipFiles: ['<node_internals>/**'],
      },
    },
    {
      label: refString('node.snippet.gulp.label'),
      description: refString('node.snippet.gulp.description'),
      body: {
        type: Contributions.NodeDebugType,
        request: 'launch',
        name: 'Gulp ${1:task}',
        program: '^"\\${workspaceFolder}/node_modules/gulp/bin/gulp.js"',
        args: ['${1:task}'],
        skipFiles: ['<node_internals>/**'],
      },
    },
    {
      label: refString('node.snippet.electron.label'),
      description: refString('node.snippet.electron.description'),
      body: {
        type: Contributions.NodeDebugType,
        request: 'launch',
        name: 'Electron Main',
        runtimeExecutable: '^"\\${workspaceFolder}/node_modules/.bin/electron"',
        program: '^"\\${workspaceFolder}/main.js"',
        skipFiles: ['<node_internals>/**'],
      },
    },
  ],
  configurationAttributes: {
    ...nodeBaseConfigurationAttributes,
    program: {
      type: 'string',
      description: refString('node.launch.program.description'),
      default: '',
    },
    stopOnEntry: {
      type: ['boolean', 'string'],
      description: refString('node.stopOnEntry.description'),
      default: true,
    },
    console: {
      type: 'string',
      enum: ['internalConsole', 'integratedTerminal', 'externalTerminal'],
      enumDescriptions: [
        refString('node.launch.console.internalConsole.description'),
        refString('node.launch.console.integratedTerminal.description'),
        refString('node.launch.console.externalTerminal.description'),
      ],
      description: refString('node.launch.console.description'),
      default: 'internalConsole',
    },
    args: {
      type: 'array',
      description: refString('node.launch.args.description'),
      items: {
        type: 'string',
      },
      default: [],
    },
    restart: {
      description: refString('node.launch.restart.description'),
      ...nodeAttachConfig.configurationAttributes.restart,
    },
    runtimeExecutable: {
      type: ['string', 'null'],
      markdownDescription: refString('node.launch.runtimeExecutable.description'),
      default: 'node',
    },
    runtimeVersion: {
      type: 'string',
      markdownDescription: refString('node.launch.runtimeVersion.description'),
      default: 'default',
    },
    runtimeArgs: {
      type: 'array',
      description: refString('node.launch.runtimeArgs.description'),
      items: {
        type: 'string',
      },
      default: [],
    },
  },
};

const nodeTerminalConfiguration: IDebugger<ITerminalLaunchConfiguration> = {
  type: Contributions.TerminalDebugType,
  request: 'launch',
  label: refString('debug.terminal.label'),
  configurationSnippets: [
    {
      label: refString('debug.terminal.snippet.label'),
      description: refString('debug.terminal.snippet.label'),
      body: {
        type: Contributions.TerminalDebugType,
        request: 'launch',
        name: 'Run npm start',
        command: 'npm start',
      },
    },
  ],
  configurationAttributes: {
    ...nodeBaseConfigurationAttributes,
    command: {
      type: ['string', 'null'],
      description: refString('debug.terminal.program.description'),
      default: 'npm start',
    },
  },
};

/**
 * Shared Chrome configuration.
 */
const chromeBaseConfigurationAttributes: ConfigurationAttributes<IChromeBaseConfiguration> = {
  ...baseConfigurationAttributes,
  port: {
    type: 'number',
    description: refString('chrome.port.description'),
    default: 9222,
  },
  address: {
    type: 'string',
    description: refString('chrome.address.description'),
    default: '127.0.0.1',
  },
  disableNetworkCache: {
    type: 'boolean',
    description: refString('chrome.disableNetworkCache.description'),
    default: true,
  },
  pathMapping: {
    type: 'object',
    description: refString('chrome.pathMapping.description'),
    default: {},
  },
  webRoot: {
    type: 'string',
    description: refString('chrome.webRoot.description'),
    default: '${workspaceFolder}',
  },
  urlFilter: {
    type: 'string',
    description: refString('chrome.urlFilter.description'),
    default: '',
  },
  url: {
    type: 'string',
    description: refString('chrome.url.description'),
    default: 'http://localhost:8080',
  },
  server: {
    oneOf: [
      {
        type: 'object',
        description: refString('chrome.server.description'),
        additionalProperties: false,
        default: { program: 'node my-server.js' },
        properties: nodeLaunchConfig.configurationAttributes,
      },
      {
        type: 'object',
        description: refString('debug.terminal.label'),
        additionalProperties: false,
        default: { program: 'npm start' },
        properties: nodeTerminalConfiguration.configurationAttributes,
      },
    ],
    // eslint-disable-next-line
  } as any,
};

const extensionHostConfig: IDebugger<IExtensionHostConfiguration> = {
  type: Contributions.ExtensionHostDebugType,
  request: 'launch',
  label: refString('extensionHost.label'),
  required: ['args'],
  configurationSnippets: [
    {
      label: refString('extensionHost.snippet.launch.label'),
      description: refString('extensionHost.snippet.launch.description'),
      body: {
        type: Contributions.ExtensionHostDebugType,
        request: 'launch',
        name: refString('extensionHost.launch.config.name'),
        runtimeExecutable: '^"\\${execPath}"',
        args: ['^"--extensionDevelopmentPath=\\${workspaceFolder}"'],
        outFiles: ['^"\\${workspaceFolder}/out/**/*.js"'],
        preLaunchTask: 'npm',
      },
    },
  ],
  configurationAttributes: {
    ...nodeBaseConfigurationAttributes,
    args: {
      type: 'array',
      description: refString('node.launch.args.description'),
      items: {
        type: 'string',
      },
      default: ['--extensionDevelopmentPath=${workspaceFolder}'],
    },
    runtimeExecutable: {
      type: ['string', 'null'],
      markdownDescription: refString('extensionHost.launch.runtimeExecutable.description'),
      default: 'node',
    },
  },
};

const chromeLaunchConfig: IDebugger<IChromeLaunchConfiguration> = {
  type: Contributions.ChromeDebugType,
  request: 'launch',
  label: refString('chrome.label'),
  configurationSnippets: [
    {
      label: refString('chrome.launch.label'),
      description: refString('chrome.launch.description'),
      body: {
        type: Contributions.ChromeDebugType,
        request: 'launch',
        name: 'Launch Chrome',
        url: 'http://localhost:8080',
        webRoot: '^"${2:\\${workspaceFolder\\}}"',
      },
    },
  ],
  configurationAttributes: {
    ...chromeBaseConfigurationAttributes,
    file: {
      type: 'string',
      description: refString('chrome.file.description'),
      default: '${workspaceFolder}/index.html',
    },
    userDataDir: {
      type: ['string', 'boolean'],
      description: refString('chrome.userDataDir.description'),
      default: true,
    },
    runtimeExecutable: {
      type: ['string', 'null'],
      description: refString('chrome.runtimeExecutable.description'),
      default: 'stable',
    },
    runtimeArgs: {
      type: 'array',
      description: refString('chrome.runtimeArgs.description'),
      items: {
        type: 'string',
      },
      default: [],
    },
    env: {
      type: 'object',
      description: refString('chrome.env.description'),
      default: {},
    },
    cwd: {
      type: 'string',
      description: refString('chrome.cwd.description'),
      default: null,
    },
  },
};

const chromeAttachConfig: IDebugger<IChromeAttachConfiguration> = {
  type: Contributions.ChromeDebugType,
  request: 'attach',
  label: refString('chrome.label'),
  configurationSnippets: [
    {
      label: refString('chrome.attach.label'),
      description: refString('chrome.attach.description'),
      body: {
        type: Contributions.ChromeDebugType,
        request: 'attach',
        name: 'Attach to Chrome',
        port: 9222,
        webRoot: '^"${2:\\${workspaceFolder\\}}"',
      },
    },
  ],
  configurationAttributes: {
    ...chromeBaseConfigurationAttributes,
  },
};

function buildDebuggers() {
  const debuggers = [
    nodeAttachConfig,
    nodeLaunchConfig,
    nodeTerminalConfiguration,
    extensionHostConfig,
    chromeLaunchConfig,
    chromeAttachConfig,
  ];

  // eslint-disable-next-line
  const output: any[] = [];
  for (const d of debuggers) {
    let entry = output.find(o => o.type === d.type);
    if (!entry) {
      // eslint-disable-next-line
      const { request, configurationAttributes, required, ...rest } = d;
      entry = {
        ...rest,
        languages: ['javascript', 'typescript', 'javascriptreact', 'typescriptreact'],
        configurationAttributes: {},
        configurationSnippets: [],
      };
      output.push(entry);
    }

    entry.configurationSnippets.push(...d.configurationSnippets);
    entry.configurationAttributes[d.request] = {
      required: d.required,
      properties: d.configurationAttributes,
    };
  }

  return walkObject(output, sortKeys);
}

const configurationSchema: ConfigurationAttributes<IConfigurationTypes> = {
  [Configuration.NpmScriptLens]: {
    enum: ['top', 'all', 'never'],
    default: 'top',
    description: refString('configuration.npmScriptLensLocation'),
  },
  [Configuration.WarnOnLongPrediction]: {
    type: 'boolean',
    default: true,
    description: refString('configuration.warnOnLongPrediction'),
  },
  [Configuration.TerminalDebugConfig]: {
    type: 'object',
    description: refString('configuration.terminalOptions'),
    default: {},
    properties: nodeTerminalConfiguration.configurationAttributes as { [key: string]: JSONSchema6 },
  },
};

process.stdout.write(
  JSON.stringify({
    debuggers: buildDebuggers(),
    configuration: {
      title: 'JavaScript Debugger',
      properties: configurationSchema,
    },
  }),
);
