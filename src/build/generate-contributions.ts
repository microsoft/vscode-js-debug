/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import { JSONSchema6, JSONSchema6Definition } from 'json-schema';
import type strings from '../../package.nls.json';
import {
  allCommands,
  allDebugTypes,
  AutoAttachMode,
  Commands,
  Configuration,
  ContextKey,
  CustomViews,
  DebugType,
  IConfigurationTypes,
  networkFilesystemScheme,
  preferredDebugTypes,
} from '../common/contributionUtils';
import { knownToolToken } from '../common/knownTools';
import { nodeInternalsToken } from '../common/node15Internal';
import { mapValues, sortKeys, walkObject } from '../common/objUtils';
import {
  AnyLaunchConfiguration,
  baseDefaults,
  breakpointLanguages,
  chromeAttachConfigDefaults,
  chromeLaunchConfigDefaults,
  edgeAttachConfigDefaults,
  edgeLaunchConfigDefaults,
  extensionHostConfigDefaults,
  IBaseConfiguration,
  IChromeAttachConfiguration,
  IChromeLaunchConfiguration,
  IChromiumBaseConfiguration,
  IEdgeAttachConfiguration,
  IEdgeLaunchConfiguration,
  IExtensionHostLaunchConfiguration,
  IMandatedConfiguration,
  INodeAttachConfiguration,
  INodeBaseConfiguration,
  INodeLaunchConfiguration,
  ITerminalLaunchConfiguration,
  KillBehavior,
  nodeAttachConfigDefaults,
  nodeLaunchConfigDefaults,
  OutputSource,
  ResolvingConfiguration,
  terminalBaseDefaults,
} from '../configuration';

const appInsightsKey = '0c6ae279ed8443289764825290e4f9e2-1a736e7c-1324-4338-be46-fc2a58ae4d14-7255';

type OmittedKeysFromAttributes =
  | keyof IMandatedConfiguration
  | 'rootPath'
  | '__breakOnConditionalError'
  | '__workspaceFolder'
  | '__workspaceCachePath'
  | '__remoteFilePrefix'
  | '__sessionId';

const enum Tag {
  // A useful attribute for project setup.
  Setup = 'setup',
}

export type DescribedAttribute<T> =
  & JSONSchema6
  & Described
  & {
    default: T;
    docDefault?: string;
    enum?: Array<T>;
    enumDescriptions?: MappedReferenceString[];
    tags?: Tag[];
  };

type ConfigurationAttributes<T> = {
  [K in keyof Omit<T, OmittedKeysFromAttributes>]: DescribedAttribute<T[K]>;
};
type Described =
  | { description: MappedReferenceString }
  | { enumDescriptions: MappedReferenceString[] }
  | { markdownDescription: MappedReferenceString }
  | { deprecated: boolean };

type Menus = {
  [menuId: string]: {
    command: Commands;
    title?: MappedReferenceString;
    when?: string;
    group?: 'navigation' | 'inline' | string;
  }[];
};

const forSomeContextKeys = (
  types: Iterable<string>,
  contextKey: string,
  andExpr: string | undefined,
) => [...types].map(d => `${contextKey} == ${d}` + (andExpr ? ` && ${andExpr}` : '')).join(' || ');

const forAnyDebugType = (contextKey: string, andExpr?: string) =>
  forSomeContextKeys(allDebugTypes, contextKey, andExpr);

const forBrowserDebugType = (contextKey: string, andExpr?: string) =>
  forSomeContextKeys([DebugType.Chrome, DebugType.Edge], contextKey, andExpr);

const forNodeDebugType = (contextKey: string, andExpr?: string) =>
  forSomeContextKeys([DebugType.Node, DebugType.ExtensionHost, 'node'], contextKey, andExpr);

/**
 * Opaque type for a string passed through refString, ensuring all templates
 * are defined as NLS strings.
 */
type MappedReferenceString = { __opaque: true } & string;

const refString = (str: keyof typeof strings & string): MappedReferenceString =>
  `%${str}%` as unknown as MappedReferenceString;

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
  languages: string[];
  variables?: { [key: string]: Commands };
  required?: (keyof T)[];
  configurationSnippets: ({
    label: MappedReferenceString;
    body: ResolvingConfiguration<T & { preLaunchTask?: string }>;
  } & Described)[];
  configurationAttributes: ConfigurationAttributes<T>;
  defaults: T;
  strings?: { unverifiedBreakpoints?: string };
}

const commonLanguages = ['javascript', 'typescript', 'javascriptreact', 'typescriptreact'];
const browserLanguages = [...commonLanguages, 'html', 'css', 'coffeescript', 'handlebars', 'vue'];

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
    default: [...baseDefaults.outFiles],
    items: {
      type: 'string',
    },
    tags: [Tag.Setup],
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
    default: ['${/**'],
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
  sourceMapRenames: {
    type: 'boolean',
    default: true,
    description: refString('browser.sourceMapRenames.description'),
  },
  sourceMapPathOverrides: {
    type: 'object',
    description: refString('node.sourceMapPathOverrides.description'),
    default: {
      'webpack://?:*/*': '${workspaceFolder}/*',
      'webpack:///./~/*': '${workspaceFolder}/node_modules/*',
      'meteor://💻app/*': '${workspaceFolder}/*',
    },
  },
  timeout: {
    type: 'number',
    description: refString('node.timeout.description'),
    default: 10000,
  },
  timeouts: {
    type: 'object',
    description: refString('timeouts.generalDescription'),
    default: {},
    properties: {
      sourceMapMinPause: {
        type: 'number',
        description: refString('timeouts.sourceMaps.sourceMapMinPause.description'),
        default: 1000,
      },
      sourceMapCumulativePause: {
        type: 'number',
        description: refString('timeouts.sourceMaps.sourceMapCumulativePause.description'),
        default: 1000,
      },
      hoverEvaluation: {
        type: 'number',
        description: refString('timeouts.hoverEvaluation.description'),
        default: 500,
      },
    },
    additionalProperties: false,
    markdownDescription: refString('timeouts.generalDescription.markdown'),
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
          stdio: {
            type: 'boolean',
            description: refString('trace.stdio.description'),
          },
          logFile: {
            type: ['string', 'null'],
            description: refString('trace.logFile.description'),
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
  enableContentValidation: {
    default: true,
    type: 'boolean',
    description: refString('enableContentValidation.description'),
  },
  customDescriptionGenerator: {
    type: 'string',
    default: undefined,
    description: refString('customDescriptionGenerator.description'),
  },
  customPropertiesGenerator: {
    type: 'string',
    default: undefined,
    deprecated: true,
    description: refString('customPropertiesGenerator.description'),
  },
  cascadeTerminateToConfigurations: {
    type: 'array',
    items: {
      type: 'string',
      uniqueItems: true,
    },
    default: [],
    description: refString('base.cascadeTerminateToConfigurations.label'),
  },
  enableDWARF: {
    type: 'boolean',
    default: true,
    markdownDescription: refString('base.enableDWARF.label'),
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
    docDefault: 'localRoot || ${workspaceFolder}',
    tags: [Tag.Setup],
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
    tags: [Tag.Setup],
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
  nodeVersionHint: {
    type: 'number',
    minimum: 8,
    description: refString('node.versionHint.description'),
    default: 12,
  },
};

const intOrEvaluated: JSONSchema6Definition[] = [
  {
    type: 'integer',
  },
  {
    type: 'string',
    pattern: '^\\${.*}$',
  },
];

/**
 * Node attach configuration.
 */
const nodeAttachConfig: IDebugger<INodeAttachConfiguration> = {
  type: DebugType.Node,
  request: 'attach',
  label: refString('node.label'),
  languages: commonLanguages,
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
        skipFiles: [`${nodeInternalsToken}/**`],
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
        skipFiles: [`${nodeInternalsToken}/**`],
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
        skipFiles: [`${nodeInternalsToken}/**`],
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
      description: refString('node.port.description'),
      default: 9229,
      oneOf: intOrEvaluated,
      tags: [Tag.Setup],
    },
    websocketAddress: {
      type: 'string',
      description: refString('node.websocket.address.description'),
      default: undefined,
    },
    remoteHostHeader: {
      type: 'string',
      description: refString('node.remote.host.header.description'),
      default: undefined,
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
  languages: commonLanguages,
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
        skipFiles: [`${nodeInternalsToken}/**`],
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
        skipFiles: [`${nodeInternalsToken}/**`],
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
        skipFiles: [`${nodeInternalsToken}/**`],
      },
    },
    {
      label: refString('node.snippet.mocha.label'),
      description: refString('node.snippet.mocha.description'),
      body: {
        type: DebugType.Node,
        request: 'launch',
        name: 'Mocha Tests',
        program: '^"mocha"',
        args: [
          '-u',
          'tdd',
          '--timeout',
          '999999',
          '--colors',
          '^"\\${workspaceFolder}/${1:test}"',
        ],
        internalConsoleOptions: 'openOnSessionStart',
        skipFiles: [`${nodeInternalsToken}/**`],
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
        skipFiles: [`${nodeInternalsToken}/**`],
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
        skipFiles: [`${nodeInternalsToken}/**`],
      },
    },
    {
      label: refString('node.snippet.electron.label'),
      description: refString('node.snippet.electron.description'),
      body: {
        type: DebugType.Node,
        request: 'launch',
        name: 'Electron Main',
        runtimeExecutable: '^"electron"',
        program: '^"\\${workspaceFolder}/main.js"',
        skipFiles: [`${nodeInternalsToken}/**`],
      },
    },
  ],
  configurationAttributes: {
    ...nodeBaseConfigurationAttributes,
    cwd: {
      type: 'string',
      description: refString('node.launch.cwd.description'),
      default: '${workspaceFolder}',
      tags: [Tag.Setup],
    },
    program: {
      type: 'string',
      description: refString('node.launch.program.description'),
      default: '',
      tags: [Tag.Setup],
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
      type: ['array', 'string'],
      description: refString('node.launch.args.description'),
      items: {
        type: 'string',
      },
      default: [],
      tags: [Tag.Setup],
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
      tags: [Tag.Setup],
    },
    profileStartup: {
      type: 'boolean',
      description: refString('node.profileStartup.description'),
      default: true,
    },
    attachSimplePort: {
      oneOf: intOrEvaluated,
      description: refString('node.attachSimplePort.description'),
      default: 9229,
    },
    killBehavior: {
      type: 'string',
      enum: [KillBehavior.Forceful, KillBehavior.Polite, KillBehavior.None],
      default: KillBehavior.Forceful,
      markdownDescription: refString('node.killBehavior.description'),
    },
    experimentalNetworking: {
      type: 'string',
      default: 'auto',
      description: refString('node.experimentalNetworking.description'),
      enum: ['auto', 'on', 'off'],
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
      tags: [Tag.Setup],
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
    tags: [Tag.Setup],
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
    tags: [Tag.Setup],
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
  perScriptSourcemaps: {
    type: 'string',
    default: 'auto',
    enum: ['yes', 'no', 'auto'],
    description: refString('browser.perScriptSourcemaps.description'),
  },
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
    oneOf: intOrEvaluated,
    description: refString('browser.attach.port.description'),
    default: 9229,
    tags: [Tag.Setup],
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
  browserAttachLocation: {
    description: refString('browser.browserAttachLocation.description'),
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
};

const chromeLaunchConfig: IDebugger<IChromeLaunchConfiguration> = {
  type: DebugType.Chrome,
  request: 'launch',
  label: refString('chrome.label'),
  languages: browserLanguages,
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
      tags: [Tag.Setup],
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
    includeLaunchArgs: {
      type: 'boolean',
      description: refString('browser.includeLaunchArgs.description'),
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
      default: 'wholeBrowser',
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
  languages: browserLanguages,
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
  languages: commonLanguages,
  required: [],
  configurationSnippets: [
    {
      label: refString('extensionHost.snippet.launch.label'),
      description: refString('extensionHost.snippet.launch.description'),
      body: {
        type: DebugType.ExtensionHost,
        request: 'launch',
        name: refString('extensionHost.launch.config.name'),
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
      tags: [Tag.Setup],
    },
    runtimeExecutable: {
      type: ['string', 'null'],
      markdownDescription: refString('extensionHost.launch.runtimeExecutable.description'),
      default: 'node',
    },
    debugWebviews: {
      markdownDescription: refString('extensionHost.launch.debugWebviews'),
      default: true,
      type: ['boolean'],
    },
    debugWebWorkerHost: {
      markdownDescription: refString('extensionHost.launch.debugWebWorkerHost'),
      default: true,
      type: ['boolean'],
    },
    rendererDebugOptions: {
      markdownDescription: refString('extensionHost.launch.rendererDebugOptions'),
      type: 'object',
      default: {
        webRoot: '${workspaceFolder}',
      },
      properties: chromiumAttachConfigurationAttributes as { [key: string]: JSONSchema6 },
    },
    testConfiguration: {
      markdownDescription: refString('extensionHost.launch.testConfiguration'),
      type: 'string',
      default: '${workspaceFolder}/.vscode-test.js',
    },
    testConfigurationLabel: {
      markdownDescription: refString('extensionHost.launch.testConfigurationLabel'),
      type: 'string',
      default: '',
    },
  },
  defaults: extensionHostConfigDefaults,
};

const edgeLaunchConfig: IDebugger<IEdgeLaunchConfiguration> = {
  type: DebugType.Edge,
  request: 'launch',
  label: refString('edge.label'),
  languages: browserLanguages,
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
      description: refString('edge.useWebView.launch.description'),
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
  languages: browserLanguages,
  configurationSnippets: [
    {
      label: refString('edge.attach.label'),
      description: refString('edge.attach.description'),
      body: {
        type: DebugType.Edge,
        request: 'attach',
        name: 'Attach to Edge',
        port: 9222,
        webRoot: '^"${2:\\${workspaceFolder\\}}"',
      },
    },
  ],
  configurationAttributes: {
    ...chromiumAttachConfigurationAttributes,
    useWebView: {
      type: 'object',
      properties: { pipeName: { type: 'string' } },
      description: refString('edge.useWebView.attach.description'),
      default: { pipeName: 'MyPipeName' },
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
  const ensureEntryForType = (type: string, d: (typeof debuggers)[0]) => {
    let entry = output.find(o => o.type === type);
    if (entry) {
      return entry;
    }

    // eslint-disable-next-line
    const { request, configurationAttributes, required, defaults, ...rest } = d;
    entry = {
      ...rest,
      type,
      aiKey: appInsightsKey,
      configurationAttributes: {},
      configurationSnippets: [],
      strings: { unverifiedBreakpoints: refString('debug.unverifiedBreakpoints') },
    };
    output.push(entry);
    return entry;
  };

  for (const d of debuggers) {
    const preferred = preferredDebugTypes.get(d.type);
    const primary = ensureEntryForType(d.type, d);
    const entries = [primary];
    if (preferred) {
      const entry = ensureEntryForType(preferred, d);
      delete entry.languages;
      entries.unshift(entry);
      primary.deprecated = `Please use type ${preferred} instead`;
    }

    entries[0].configurationSnippets.push(...d.configurationSnippets);

    if (preferred) {
      for (const snippet of entries[0].configurationSnippets) {
        snippet.body.type = preferred;
      }
    }

    for (const entry of entries) {
      entry.configurationAttributes[d.request] = {
        required: d.required,
        properties: mapValues(
          d.configurationAttributes as { [key: string]: DescribedAttribute<unknown> },
          ({ docDefault: _, ...attrs }) => attrs,
        ),
      };
    }
  }

  return walkObject(output, sortKeys);
}

const configurationSchema: ConfigurationAttributes<IConfigurationTypes> = {
  [Configuration.NpmScriptLens]: {
    enum: ['top', 'all', 'never'],
    default: 'top',
    description: refString('configuration.npmScriptLensLocation'),
  },
  [Configuration.TerminalDebugConfig]: {
    type: 'object',
    description: refString('configuration.terminalOptions'),
    default: {},
    properties: nodeTerminalConfiguration.configurationAttributes as { [key: string]: JSONSchema6 },
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
  [Configuration.AutoAttachMode]: {
    type: 'string',
    default: AutoAttachMode.Disabled,
    enum: [
      AutoAttachMode.Always,
      AutoAttachMode.Smart,
      AutoAttachMode.OnlyWithFlag,
      AutoAttachMode.Disabled,
    ],
    enumDescriptions: [
      refString('configuration.autoAttachMode.always'),
      refString('configuration.autoAttachMode.smart'),
      refString('configuration.autoAttachMode.explicit'),
      refString('configuration.autoAttachMode.disabled'),
    ],
    markdownDescription: refString('configuration.autoAttachMode'),
  },
  [Configuration.AutoAttachSmartPatterns]: {
    type: 'array',
    items: {
      type: 'string',
    },
    default: ['${workspaceFolder}/**', '!**/node_modules/**', `**/${knownToolToken}/**`],
    markdownDescription: refString('configuration.autoAttachSmartPatterns'),
  },
  [Configuration.BreakOnConditionalError]: {
    type: 'boolean',
    default: false,
    markdownDescription: refString('configuration.breakOnConditionalError'),
  },
  [Configuration.UnmapMissingSources]: {
    type: 'boolean',
    default: false,
    description: refString('configuration.unmapMissingSources'),
  },
  [Configuration.DefaultRuntimeExecutables]: {
    type: 'object',
    default: {
      [DebugType.Node]: 'node',
    },
    markdownDescription: refString('configuration.defaultRuntimeExecutables'),
    properties: [DebugType.Node, DebugType.Chrome, DebugType.Edge].reduce(
      (obj, type) => ({ ...obj, [type]: { type: 'string' } }),
      {},
    ),
  },
  [Configuration.ResourceRequestOptions]: {
    type: 'object',
    default: {},
    markdownDescription: refString('configuration.resourceRequestOptions'),
  },
  [Configuration.EnableNetworkView]: {
    type: 'boolean',
    default: false,
    description: refString('configuration.enableNetworkView'),
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
    icon: '$(json)',
  },
  {
    command: Commands.ToggleSkipping,
    title: refString('toggle.skipping.this.file'),
    category: 'Debug',
  },
  {
    command: Commands.ToggleCustomBreakpoints,
    title: refString('add.eventListener.breakpoint'),
    icon: '$(add)',
  },
  {
    command: Commands.RemoveAllCustomBreakpoints,
    title: refString('remove.eventListener.breakpoint.all'),
    icon: '$(close-all)',
  },
  {
    command: Commands.AddXHRBreakpoints,
    title: refString('add.xhr.breakpoint'),
    icon: '$(add)',
  },
  {
    command: Commands.RemoveXHRBreakpoints,
    title: refString('remove.xhr.breakpoint'),
    icon: '$(remove)',
  },
  {
    command: Commands.EditXHRBreakpoint,
    title: refString('edit.xhr.breakpoint'),
    icon: '$(edit)',
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
  {
    command: Commands.DebugLink,
    title: refString('debugLink.label'),
    category: 'Debug',
  },
  {
    command: Commands.CreateDiagnostics,
    title: refString('createDiagnostics.label'),
    category: 'Debug',
  },
  {
    command: Commands.GetDiagnosticLogs,
    title: refString('getDiagnosticLogs.label'),
    category: 'Debug',
  },
  {
    command: Commands.StartWithStopOnEntry,
    title: refString('startWithStopOnEntry.label'),
    category: 'Debug',
  },
  {
    command: Commands.OpenEdgeDevTools,
    title: refString('openEdgeDevTools.label'),
    icon: '$(inspect)',
    category: 'Debug',
  },
  {
    command: Commands.CallersAdd,
    title: refString('commands.callersAdd.label'),
    category: 'Debug',
  },
  {
    command: Commands.CallersRemove,
    title: refString('commands.callersRemove.label'),
    icon: '$(close)',
  },
  {
    command: Commands.CallersRemoveAll,
    title: refString('commands.callersRemoveAll.label'),
    icon: '$(clear-all)',
  },
  {
    command: Commands.CallersGoToCaller,
    title: refString('commands.callersGoToCaller.label'),
    icon: '$(call-outgoing)',
  },
  {
    command: Commands.CallersGoToTarget,
    title: refString('commands.callersGoToTarget.label'),
    icon: '$(call-incoming)',
  },
  {
    command: Commands.EnableSourceMapStepping,
    title: refString('commands.enableSourceMapStepping.label'),
    icon: '$(compass-dot)',
  },
  {
    command: Commands.DisableSourceMapStepping,
    title: refString('commands.disableSourceMapStepping.label'),
    icon: '$(compass)',
  },
  {
    command: Commands.NetworkViewRequest,
    title: refString('commands.networkViewRequest.label'),
    icon: '$(arrow-right)',
  },
  {
    command: Commands.NetworkClear,
    title: refString('commands.networkClear.label'),
    icon: '$(clear-all)',
  },
  {
    command: Commands.NetworkOpenBody,
    title: refString('commands.networkOpenBody.label'),
  },
  {
    command: Commands.NetworkOpenBodyHex,
    title: refString('commands.networkOpenBodyInHexEditor.label'),
  },
  {
    command: Commands.NetworkReplayXHR,
    title: refString('commands.networkReplayXHR.label'),
  },
  {
    command: Commands.NetworkCopyUri,
    title: refString('commands.networkCopyURI.label'),
  },
];

const menus: Menus = {
  commandPalette: [
    {
      command: Commands.PrettyPrint,
      title: refString('pretty.print.script'),
      when: forAnyDebugType('debugType', 'debugState == stopped'),
    },
    {
      command: Commands.StartProfile,
      title: refString('profile.start'),
      when: forAnyDebugType('debugType', 'inDebugMode && !jsDebugIsProfiling'),
    },
    {
      command: Commands.StopProfile,
      title: refString('profile.stop'),
      when: forAnyDebugType('debugType', 'inDebugMode && jsDebugIsProfiling'),
    },
    {
      command: Commands.RevealPage,
      when: 'false',
    },
    {
      command: Commands.DebugLink,
      title: refString('debugLink.label'),
      when: '!isWeb',
    },
    {
      command: Commands.CreateDiagnostics,
      title: refString('createDiagnostics.label'),
      when: forAnyDebugType('debugType', 'inDebugMode'),
    },
    {
      command: Commands.GetDiagnosticLogs,
      title: refString('getDiagnosticLogs.label'),
      when: forAnyDebugType('debugType', 'inDebugMode'),
    },
    {
      command: Commands.OpenEdgeDevTools,
      title: refString('openEdgeDevTools.label'),
      when: `debugType == ${DebugType.Edge}`,
    },
    {
      command: Commands.CallersAdd,
      title: refString('commands.callersAdd.paletteLabel'),
      when: forAnyDebugType('debugType', 'debugState == "stopped"'),
    },
    {
      command: Commands.CallersGoToCaller,
      when: 'false',
    },
    {
      command: Commands.CallersGoToTarget,
      when: 'false',
    },
    {
      command: Commands.NetworkCopyUri,
      when: 'false',
    },
    {
      command: Commands.NetworkOpenBody,
      when: 'false',
    },
    {
      command: Commands.NetworkOpenBodyHex,
      when: 'false',
    },
    {
      command: Commands.NetworkReplayXHR,
      when: 'false',
    },
    {
      command: Commands.NetworkViewRequest,
      when: 'false',
    },
    {
      command: Commands.NetworkClear,
      when: 'false',
    },
    {
      command: Commands.EnableSourceMapStepping,
      when: ContextKey.IsMapSteppingDisabled,
    },
    {
      command: Commands.DisableSourceMapStepping,
      when: `!${ContextKey.IsMapSteppingDisabled}`,
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
    {
      command: Commands.CallersAdd,
      when: forAnyDebugType('debugType', `callStackItemType == 'stackFrame'`),
    },
  ],
  'debug/toolBar': [
    {
      command: Commands.StopProfile,
      when: forAnyDebugType('debugType', 'jsDebugIsProfiling'),
    },
    {
      command: Commands.OpenEdgeDevTools,
      when: `debugType == ${DebugType.Edge}`,
    },
    {
      command: Commands.EnableSourceMapStepping,
      when: ContextKey.IsMapSteppingDisabled,
    },
  ],
  'view/title': [
    {
      command: Commands.ToggleCustomBreakpoints,
      when: `view == ${CustomViews.EventListenerBreakpoints}`,
      group: 'navigation',
    },
    {
      command: Commands.RemoveAllCustomBreakpoints,
      when: `view == ${CustomViews.EventListenerBreakpoints}`,
      group: 'navigation',
    },
    {
      command: Commands.CallersRemoveAll,
      group: 'navigation',
      when: `view == ${CustomViews.ExcludedCallers}`,
    },
    {
      command: Commands.DisableSourceMapStepping,
      group: 'navigation',
      when: forAnyDebugType(
        'debugType',
        `view == workbench.debug.callStackView && !${ContextKey.IsMapSteppingDisabled}`,
      ),
    },
    {
      command: Commands.EnableSourceMapStepping,
      group: 'navigation',
      when: forAnyDebugType(
        'debugType',
        `view == workbench.debug.callStackView && ${ContextKey.IsMapSteppingDisabled}`,
      ),
    },
    {
      command: Commands.NetworkClear,
      group: 'navigation',
      when: `view == ${CustomViews.Network}`,
    },
  ],
  'view/item/context': [
    {
      command: Commands.AddXHRBreakpoints,
      when: `view == ${CustomViews.EventListenerBreakpoints} && viewItem == xhrBreakpoint`,
    },
    {
      command: Commands.EditXHRBreakpoint,
      when: `view == ${CustomViews.EventListenerBreakpoints} && viewItem == xhrBreakpoint`,
      group: 'inline',
    },
    {
      command: Commands.EditXHRBreakpoint,
      when: `view == ${CustomViews.EventListenerBreakpoints} && viewItem == xhrBreakpoint`,
    },
    {
      command: Commands.RemoveXHRBreakpoints,
      when: `view == ${CustomViews.EventListenerBreakpoints} && viewItem == xhrBreakpoint`,
      group: 'inline',
    },
    {
      command: Commands.RemoveXHRBreakpoints,
      when: `view == ${CustomViews.EventListenerBreakpoints} && viewItem == xhrBreakpoint`,
    },
    {
      command: Commands.AddXHRBreakpoints,
      when: `view == ${CustomViews.EventListenerBreakpoints} && viewItem == xhrCategory`,
      group: 'inline',
    },
    {
      command: Commands.CallersGoToCaller,
      group: 'inline',
      when: `view == ${CustomViews.ExcludedCallers}`,
    },
    {
      command: Commands.CallersGoToTarget,
      group: 'inline',
      when: `view == ${CustomViews.ExcludedCallers}`,
    },
    {
      command: Commands.CallersRemove,
      group: 'inline',
      when: `view == ${CustomViews.ExcludedCallers}`,
    },
    {
      command: Commands.NetworkViewRequest,
      group: 'inline@1',
      when: `view == ${CustomViews.Network}`,
    },
    {
      command: Commands.NetworkOpenBody,
      group: 'body@1',
      when: `view == ${CustomViews.Network}`,
    },
    {
      command: Commands.NetworkOpenBodyHex,
      group: 'body@2',
      when: `view == ${CustomViews.Network}`,
    },
    {
      command: Commands.NetworkCopyUri,
      group: 'other@1',
      when: `view == ${CustomViews.Network}`,
    },
    {
      command: Commands.NetworkReplayXHR,
      group: 'other@2',
      when: `view == ${CustomViews.Network}`,
    },
  ],
  'editor/title': [
    {
      command: Commands.PrettyPrint,
      group: 'navigation',
      when: `debugState == stopped && resource in ${ContextKey.CanPrettyPrint}`,
    },
  ],
};

const keybindings = [
  {
    command: Commands.StartWithStopOnEntry,
    key: 'F10',
    mac: 'F10',
    when: forNodeDebugType('debugConfigurationType', '!inDebugMode'),
  },
  {
    command: Commands.StartWithStopOnEntry,
    key: 'F11',
    mac: 'F11',
    when: forNodeDebugType(
      'debugConfigurationType',
      '!inDebugMode && activeViewlet == workbench.view.debug',
    ),
  },
];

const viewsWelcome = [
  {
    view: 'debug',
    contents: refString('debug.terminal.welcomeWithLink'),
    when: forSomeContextKeys(commonLanguages, 'debugStartLanguage', '!isWeb'),
  },
  {
    view: 'debug',
    contents: refString('debug.terminal.welcome'),
    when: forSomeContextKeys(commonLanguages, 'debugStartLanguage', 'isWeb'),
  },
];

const views = {
  debug: [
    {
      id: CustomViews.EventListenerBreakpoints,
      name: 'Event Listener Breakpoints',
      when: forBrowserDebugType('debugType'),
    },
    {
      id: CustomViews.ExcludedCallers,
      name: 'Excluded Callers',
      when: forAnyDebugType('debugType', 'jsDebugHasExcludedCallers'),
    },
    {
      id: CustomViews.Network,
      name: 'Network',
      when: ContextKey.NetworkAvailable,
    },
  ],
};

const activationEvents = new Set([
  'onDebugDynamicConfigurations',
  'onDebugInitialConfigurations',
  `onFileSystem:${networkFilesystemScheme}`,
  ...[...debuggers.map(dbg => dbg.type), ...preferredDebugTypes.values()].map(
    t => `onDebugResolve:${t}`,
  ),
  ...[...allCommands].map(cmd => `onCommand:${cmd}`),
]);

// remove implicit commands:
for (const { command } of commands) {
  activationEvents.delete(`onCommand:${command}`);
}

if (require.main === module) {
  process.stdout.write(
    JSON.stringify({
      capabilities: {
        virtualWorkspaces: false,
        untrustedWorkspaces: {
          supported: 'limited',
          description: refString('workspaceTrust.description'),
        },
      },
      activationEvents: [...activationEvents],
      contributes: {
        menus,
        breakpoints: breakpointLanguages.map(language => ({ language })),
        debuggers: buildDebuggers(),
        commands,
        keybindings,
        configuration: {
          title: 'JavaScript Debugger',
          properties: configurationSchema,
        },
        grammars: [
          {
            language: 'wat',
            scopeName: 'text.wat',
            path: './src/ui/basic-wat.tmLanguage.json',
          },
        ],
        languages: [
          {
            id: 'wat',
            extensions: ['.wat', '.wasm'],
            aliases: ['WebAssembly Text Format'],
            firstLine: '^\\(module',
            mimetypes: ['text/wat'],
          },
        ],
        terminal: {
          profiles: [
            {
              id: 'extension.js-debug.debugTerminal',
              title: refString('debug.terminal.label'),
              icon: '$(debug)',
            },
          ],
        },
        views,
        viewsWelcome,
      },
    }),
  );
}
