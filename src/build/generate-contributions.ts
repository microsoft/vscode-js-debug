/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import {
  DebugType,
  IConfigurationTypes,
  Configuration,
  allCommands,
  Commands,
  allDebugTypes,
} from '../common/contributionUtils';
import {
  IMandatedConfiguration,
  AnyLaunchConfiguration,
  ResolvingConfiguration,
  INodeAttachConfiguration,
  INodeBaseConfiguration,
  IBaseConfiguration,
  OutputSource,
  INodeLaunchConfiguration,
  IExtensionHostLaunchConfiguration,
  IChromiumBaseConfiguration,
  IChromeLaunchConfiguration,
  IChromeAttachConfiguration,
  ITerminalLaunchConfiguration,
  baseDefaults,
  IEdgeLaunchConfiguration,
  IEdgeAttachConfiguration,
  breakpointLanguages,
  nodeAttachConfigDefaults,
  nodeLaunchConfigDefaults,
  terminalBaseDefaults,
  extensionHostConfigDefaults,
  chromeLaunchConfigDefaults,
  chromeAttachConfigDefaults,
  edgeLaunchConfigDefaults,
  edgeAttachConfigDefaults,
} from '../configuration';
import { JSONSchema6 } from 'json-schema';
import strings from './strings';
import { walkObject, sortKeys } from '../common/objUtils';

const appInsightsKey = 'AIF-d9b70cd4-b9f9-4d70-929b-a071c400b217';

type OmittedKeysFromAttributes =
  | keyof IMandatedConfiguration
  | 'rootPath'
  | '__workspaceFolder'
  | '__workspaceCachePath'
  | '__autoExpandGetters'
  | '__sessionId';

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

type Menus = {
  [menuId: string]: {
    command: Commands;
    title?: MappedReferenceString;
    when?: string;
    group?: 'navigation' | 'inline';
  }[];
};

const forSomeDebugTypes = (
  types: Iterable<string>,
  contextKey: string,
  andExpr: string | undefined,
) => [...types].map(d => `${contextKey} == ${d}` + (andExpr ? ` && ${andExpr}` : '')).join(' || ');

const forAnyDebugType = (contextKey: string, andExpr?: string) =>
  forSomeDebugTypes(allDebugTypes, contextKey, andExpr);

const forBrowserDebugType = (contextKey: string, andExpr?: string) =>
  forSomeDebugTypes([DebugType.Chrome, DebugType.Edge], contextKey, andExpr);

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
  languages?: string[];
  variables?: { [key: string]: Commands };
  required?: (keyof T)[];
  configurationSnippets: ({
    label: MappedReferenceString;
    body: ResolvingConfiguration<T & { preLaunchTask?: string }>;
  } & Described)[];
  configurationAttributes: ConfigurationAttributes<T>;
  defaults: T;
}

const baseConfigurationAttributes: ConfigurationAttributes<IBaseConfiguration> = {
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
    description: refString('browser.skipFiles.description'),
    default: ['<node_internals>/**'],
  },
  smartStep: {
    type: 'boolean',
    description: refString('smartStep.description'),
    default: true,
  },
  sourceMaps: {
    type: 'boolean',
    description: refString('browser.sourceMaps.description'),
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
            description: refString('trace.stdio.description'),
          },
          stdio: {
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
    markdownDescription: refString('node.launch.outputCapture.description'),
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
  runtimeSourcemapPausePatterns: {
    type: 'array',
    items: {
      type: 'string',
    },
    markdownDescription: refString('node.launch.runtimeSourcemapPausePatterns'),
    default: [],
  },
};

/**
 * Node attach configuration.
 */
const nodeAttachConfig: IDebugger<INodeAttachConfiguration> = {
  type: DebugType.Node,
  request: 'attach',
  label: refString('node.label'),
  variables: {
    PickProcess: Commands.PickProcess,
  },
  configurationSnippets: [
    {
      label: refString('node.snippet.attach.label'),
      description: refString('node.snippet.attach.description'),
      body: {
        type: DebugType.Node,
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
        type: DebugType.Node,
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
        type: DebugType.Node,
        request: 'attach',
        name: '${1:Attach by Process ID}',
        processId: '^"\\${command:PickProcess}"',
        skipFiles: ['<node_internals>/**'],
      },
    },
  ],
  configurationAttributes: {
    ...nodeBaseConfigurationAttributes,
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
    restart: {
      description: refString('node.attach.restart.description'),
      default: true,
      oneOf: [
        {
          type: 'boolean',
        },
        {
          type: 'object',
          required: ['static'],
          properties: {
            delay: { type: 'number', minimum: 0, default: 1000 },
            maxAttempts: { type: 'number', minimum: 0, default: 10 },
          },
        },
      ],
    },
    processId: {
      type: 'string',
      description: refString('node.attach.processId.description'),
      default: '${command:PickProcess}',
    },
    attachExistingChildren: {
      type: 'boolean',
      description: refString('node.attach.attachExistingChildren.description'),
      default: false,
    },
    continueOnAttach: {
      type: 'boolean',
      markdownDescription: refString('node.attach.continueOnAttach'),
      default: true,
    },
  },
  defaults: nodeAttachConfigDefaults,
};

/**
 * Node attach configuration.
 */
const nodeLaunchConfig: IDebugger<INodeLaunchConfiguration> = {
  type: DebugType.Node,
  request: 'launch',
  label: refString('node.label'),
  variables: {
    PickProcess: Commands.PickProcess,
  },
  configurationSnippets: [
    {
      label: refString('node.snippet.launch.label'),
      description: refString('node.snippet.launch.description'),
      body: {
        type: DebugType.Node,
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
        type: DebugType.Node,
        request: 'launch',
        name: '${1:Launch via NPM}',
        runtimeExecutable: 'npm',
        runtimeArgs: ['run-script', 'debug'],
        skipFiles: ['<node_internals>/**'],
      },
    },
    {
      label: refString('node.snippet.nodemon.label'),
      description: refString('node.snippet.nodemon.description'),
      body: {
        type: DebugType.Node,
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
        type: DebugType.Node,
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
        type: DebugType.Node,
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
        type: DebugType.Node,
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
        type: DebugType.Node,
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
    cwd: {
      type: 'string',
      description: refString('node.launch.cwd.description'),
      default: '${workspaceFolder}',
    },
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
    profileStartup: {
      type: 'boolean',
      description: refString('node.profileStartup.description'),
      default: true,
    },
  },
  defaults: nodeLaunchConfigDefaults,
};

const nodeTerminalConfiguration: IDebugger<ITerminalLaunchConfiguration> = {
  type: DebugType.Terminal,
  request: 'launch',
  label: refString('debug.terminal.label'),
  languages: [],
  configurationSnippets: [
    {
      label: refString('debug.terminal.snippet.label'),
      description: refString('debug.terminal.snippet.label'),
      body: {
        type: DebugType.Terminal,
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
  defaults: terminalBaseDefaults,
};

/**
 * Shared Chrome configuration.
 */
const chromiumBaseConfigurationAttributes: ConfigurationAttributes<IChromiumBaseConfiguration> = {
  ...baseConfigurationAttributes,
  disableNetworkCache: {
    type: 'boolean',
    description: refString('browser.disableNetworkCache.description'),
    default: true,
  },
  pathMapping: {
    type: 'object',
    description: refString('browser.pathMapping.description'),
    default: {},
  },
  webRoot: {
    type: 'string',
    description: refString('browser.webRoot.description'),
    default: '${workspaceFolder}',
  },
  urlFilter: {
    type: 'string',
    description: refString('browser.urlFilter.description'),
    default: '',
  },
  url: {
    type: 'string',
    description: refString('browser.url.description'),
    default: 'http://localhost:8080',
  },
  inspectUri: {
    type: ['string', 'null'],
    description: refString('browser.inspectUri.description'),
    default: null,
  },
  vueComponentPaths: {
    type: 'array',
    description: refString('browser.vueComponentPaths'),
    default: ['${workspaceFolder}/**/*.vue'],
  },
  server: {
    oneOf: [
      {
        type: 'object',
        description: refString('browser.server.description'),
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

/**
 * Shared Chrome attach.
 */
const chromiumAttachConfigurationAttributes: ConfigurationAttributes<IChromeAttachConfiguration> = {
  ...chromiumBaseConfigurationAttributes,
  address: {
    type: 'string',
    description: refString('browser.address.description'),
    default: 'localhost',
  },
  port: {
    type: 'number',
    description: refString('browser.attach.port.description'),
    default: 9229,
  },
  restart: {
    type: 'boolean',
    markdownDescription: refString('browser.restart'),
    default: false,
  },
  targetSelection: {
    type: 'string',
    markdownDescription: refString('browser.targetSelection'),
    enum: ['pick', 'automatic'],
    default: 'automatic',
  },
};

const chromeLaunchConfig: IDebugger<IChromeLaunchConfiguration> = {
  type: DebugType.Chrome,
  request: 'launch',
  label: refString('chrome.label'),
  configurationSnippets: [
    {
      label: refString('chrome.launch.label'),
      description: refString('chrome.launch.description'),
      body: {
        type: DebugType.Chrome,
        request: 'launch',
        name: 'Launch Chrome',
        url: 'http://localhost:8080',
        webRoot: '^"${2:\\${workspaceFolder\\}}"',
      },
    },
  ],
  configurationAttributes: {
    ...chromiumBaseConfigurationAttributes,
    port: {
      type: 'number',
      description: refString('browser.launch.port.description'),
      default: 0,
    },
    file: {
      type: 'string',
      description: refString('browser.file.description'),
      default: '${workspaceFolder}/index.html',
    },
    userDataDir: {
      type: ['string', 'boolean'],
      description: refString('browser.userDataDir.description'),
      default: true,
    },
    includeDefaultArgs: {
      type: 'boolean',
      description: refString('browser.includeDefaultArgs.description'),
      default: true,
    },
    runtimeExecutable: {
      type: ['string', 'null'],
      description: refString('browser.runtimeExecutable.description'),
      default: 'stable',
    },
    runtimeArgs: {
      type: 'array',
      description: refString('browser.runtimeArgs.description'),
      items: {
        type: 'string',
      },
      default: [],
    },
    env: {
      type: 'object',
      description: refString('browser.env.description'),
      default: {},
    },
    cwd: {
      type: 'string',
      description: refString('browser.cwd.description'),
      default: null,
    },
    profileStartup: {
      type: 'boolean',
      description: refString('browser.profileStartup.description'),
      default: true,
    },
    cleanUp: {
      type: 'string',
      enum: ['wholeBrowser', 'onlyTab'],
      description: refString('browser.cleanUp.description'),
      default: 'onlyTab',
    },
    browserLaunchLocation: {
      description: refString('browser.browserLaunchLocation.description'),
      default: null,
      oneOf: [
        {
          type: 'null',
        },
        {
          type: 'string',
          enum: ['ui', 'workspace'],
        },
      ],
    },
  },
  defaults: chromeLaunchConfigDefaults,
};

const chromeAttachConfig: IDebugger<IChromeAttachConfiguration> = {
  type: DebugType.Chrome,
  request: 'attach',
  label: refString('chrome.label'),
  configurationSnippets: [
    {
      label: refString('chrome.attach.label'),
      description: refString('chrome.attach.description'),
      body: {
        type: DebugType.Chrome,
        request: 'attach',
        name: 'Attach to Chrome',
        port: 9222,
        webRoot: '^"${2:\\${workspaceFolder\\}}"',
      },
    },
  ],
  configurationAttributes: chromiumAttachConfigurationAttributes,
  defaults: chromeAttachConfigDefaults,
};

const extensionHostConfig: IDebugger<IExtensionHostLaunchConfiguration> = {
  type: DebugType.ExtensionHost,
  request: 'launch',
  label: refString('extensionHost.label'),
  required: ['args'],
  configurationSnippets: [
    {
      label: refString('extensionHost.snippet.launch.label'),
      description: refString('extensionHost.snippet.launch.description'),
      body: {
        type: DebugType.ExtensionHost,
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
    debugWebviews: {
      markdownDescription: refString('extensionHost.launch.debugWebviews'),
      default: true,
      oneOf: [
        {
          type: ['boolean'],
          default: true,
        },
        {
          type: 'object',
          properties: chromiumAttachConfigurationAttributes as { [key: string]: JSONSchema6 },
        },
      ],
    },
  },
  defaults: extensionHostConfigDefaults,
};

const edgeLaunchConfig: IDebugger<IEdgeLaunchConfiguration> = {
  type: DebugType.Edge,
  request: 'launch',
  label: refString('edge.launch.label'),
  configurationSnippets: [
    {
      label: refString('edge.launch.label'),
      description: refString('edge.launch.description'),
      body: {
        type: DebugType.Edge,
        request: 'launch',
        name: 'Launch Edge',
        url: 'http://localhost:8080',
        webRoot: '^"${2:\\${workspaceFolder\\}}"',
      },
    },
  ],
  configurationAttributes: {
    ...chromeLaunchConfig.configurationAttributes,
    runtimeExecutable: {
      type: ['string', 'null'],
      description: refString('browser.runtimeExecutable.edge.description'),
      default: 'stable',
    },
    useWebView: {
      type: 'boolean',
      description: refString('edge.useWebView.description'),
      default: false,
    },
    address: {
      type: 'string',
      description: refString('edge.address.description'),
      default: 'localhost',
    },
    port: {
      type: 'number',
      description: refString('edge.port.description'),
      default: 9229,
    },
  },
  defaults: edgeLaunchConfigDefaults,
};

const edgeAttachConfig: IDebugger<IEdgeAttachConfiguration> = {
  type: DebugType.Edge,
  request: 'attach',
  label: refString('edge.label'),
  configurationSnippets: [
    {
      label: refString('edge.attach.label'),
      description: refString('edge.attach.description'),
      body: {
        type: DebugType.Edge,
        request: 'attach',
        name: 'Attach to Chrome',
        port: 9222,
        webRoot: '^"${2:\\${workspaceFolder\\}}"',
      },
    },
  ],
  configurationAttributes: {
    ...chromiumAttachConfigurationAttributes,
    useWebView: {
      type: 'boolean',
      description: refString('edge.useWebView.description'),
      default: false,
    },
  },
  defaults: edgeAttachConfigDefaults,
};

export const debuggers = [
  nodeAttachConfig,
  nodeLaunchConfig,
  nodeTerminalConfiguration,
  extensionHostConfig,
  chromeLaunchConfig,
  chromeAttachConfig,
  edgeLaunchConfig,
  edgeAttachConfig,
];

function buildDebuggers() {
  // eslint-disable-next-line
  const output: any[] = [];
  for (const d of debuggers) {
    let entry = output.find(o => o.type === d.type);
    if (!entry) {
      // eslint-disable-next-line
      const { request, configurationAttributes, required, defaults, ...rest } = d;
      entry = {
        languages: ['javascript', 'typescript', 'javascriptreact', 'typescriptreact'],
        ...rest,
        aiKey: appInsightsKey,
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
  [Configuration.UsePreviewDebugger]: {
    type: 'boolean',
    default: false,
    description: refString('configuration.usePreview'),
  },
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
  [Configuration.SuggestPrettyPrinting]: {
    type: 'boolean',
    description: refString('configuration.suggestPrettyPrinting'),
    default: true,
  },
  [Configuration.AutoServerTunnelOpen]: {
    type: 'boolean',
    description: refString('configuration.automaticallyTunnelRemoteServer'),
    default: true,
  },
  [Configuration.DebugByLinkOptions]: {
    default: 'on',
    description: refString('configuration.debugByLinkOptions'),
    oneOf: [
      {
        type: 'string',
        enum: ['on', 'off', 'always'],
      },
      {
        type: 'object',
        properties: {
          ...chromeLaunchConfig.configurationAttributes,
          enabled: {
            type: 'string',
            enum: ['on', 'off', 'always'],
          },
        } as { [key: string]: JSONSchema6 },
      },
    ],
  },
  [Configuration.PickAndAttachDebugOptions]: {
    type: 'object',
    default: {},
    markdownDescription: refString('configuration.pickAndAttachOptions'),
    properties: nodeAttachConfig.configurationAttributes as { [key: string]: JSONSchema6 },
  },
  [Configuration.AutoExpandGetters]: {
    type: 'boolean',
    default: false,
    markdownDescription: refString('configuration.autoExpandGetters'),
  },
};

const commands: ReadonlyArray<{
  command: Commands;
  title: MappedReferenceString;
  category?: string;
  icon?: string;
}> = [
  {
    command: Commands.PrettyPrint,
    title: refString('pretty.print.script'),
    category: 'Debug',
  },
  {
    command: Commands.ToggleSkipping,
    title: refString('toggle.skipping.this.file'),
    category: 'Debug',
  },
  {
    command: Commands.AddCustomBreakpoints,
    title: refString('add.browser.breakpoint'),
    icon: '$(add)',
  },
  {
    command: Commands.RemoveCustomBreakpoint,
    title: refString('remove.browser.breakpoint'),
    icon: '$(remove)',
  },
  {
    command: Commands.RemoveAllCustomBreakpoints,
    title: refString('remove.browser.breakpoint.all'),
    icon: '$(close-all)',
  },
  {
    command: Commands.AttachProcess,
    title: refString('attach.node.process'),
    category: 'Debug',
  },
  {
    command: Commands.DebugNpmScript,
    title: refString('debug.npm.script'),
    category: 'Debug',
  },
  {
    command: Commands.CreateDebuggerTerminal,
    title: refString('debug.terminal.label'),
    category: 'Debug',
  },
  {
    command: Commands.StartProfile,
    title: refString('profile.start'),
    category: 'Debug',
    icon: '$(record)',
  },
  {
    command: Commands.StopProfile,
    title: refString('profile.stop'),
    category: 'Debug',
    icon: 'resources/dark/stop-profiling.svg',
  },
  {
    command: Commands.RevealPage,
    title: refString('browser.revealPage'),
    category: 'Debug',
  },
];

const menus: Menus = {
  commandPalette: [
    {
      command: Commands.PrettyPrint,
      title: refString('pretty.print.script'),
      when: forAnyDebugType('debugType', 'inDebugMode'),
    },
    {
      command: Commands.StartProfile,
      title: refString('profile.start'),
      when: forAnyDebugType('debugType', 'inDebugMode && !jsDebugIsProfiling'),
    },
    {
      command: Commands.StartProfile,
      title: refString('profile.stop'),
      when: forAnyDebugType('debugType', 'inDebugMode && jsDebugIsProfiling'),
    },
    {
      command: Commands.RevealPage,
      when: 'false',
    },
  ],
  'debug/callstack/context': [
    {
      command: Commands.RevealPage,
      group: 'navigation',
      when: forBrowserDebugType('debugType', `callStackItemType == 'session'`),
    },
    {
      command: Commands.ToggleSkipping,
      group: 'navigation',
      when: forAnyDebugType('debugType', `callStackItemType == 'session'`),
    },
    {
      command: Commands.StartProfile,
      group: 'navigation',
      when: forAnyDebugType('debugType', `!jsDebugIsProfiling && callStackItemType == 'session'`),
    },
    {
      command: Commands.StopProfile,
      group: 'navigation',
      when: forAnyDebugType('debugType', `jsDebugIsProfiling && callStackItemType == 'session'`),
    },
    {
      command: Commands.StartProfile,
      group: 'inline',
      when: forAnyDebugType('debugType', '!jsDebugIsProfiling'),
    },
    {
      command: Commands.StopProfile,
      group: 'inline',
      when: forAnyDebugType('debugType', 'jsDebugIsProfiling'),
    },
  ],
  'debug/toolBar': [
    {
      command: Commands.StopProfile,
      when: forAnyDebugType('debugType', 'jsDebugIsProfiling'),
    },
  ],
  'view/title': [
    {
      command: Commands.AddCustomBreakpoints,
      when: 'view == jsBrowserBreakpoints',
    },
    {
      command: Commands.RemoveAllCustomBreakpoints,
      when: 'view == jsBrowserBreakpoints',
    },
  ],
  'view/item/context': [
    {
      command: Commands.RemoveCustomBreakpoint,
      when: 'view == jsBrowserBreakpoints',
      group: 'inline',
    },
    {
      command: Commands.AddCustomBreakpoints,
      when: 'view == jsBrowserBreakpoints',
    },
    {
      command: Commands.RemoveCustomBreakpoint,
      when: 'view == jsBrowserBreakpoints',
    },
  ],
};

if (require.main === module) {
  process.stdout.write(
    JSON.stringify({
      activationEvents: [
        ...[...allCommands].map(cmd => `onCommand:${cmd}`),
        ...debuggers.map(dbg => `onDebugResolve:${dbg.type}`),
      ],
      contributes: {
        menus,
        breakpoints: breakpointLanguages.map(language => ({ language })),
        debuggers: buildDebuggers(),
        commands,
        configuration: {
          title: 'JavaScript Debugger',
          properties: configurationSchema,
        },
      },
    }),
  );
}
