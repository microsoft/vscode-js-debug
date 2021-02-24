/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import { Commands } from '../common/contributionUtils';
import { sortKeys } from '../common/objUtils';

const strings = {
  'attach.node.process': 'Attach to Node Process',
  'extension.description': 'An extension for debugging Node.js programs and Chrome.',
  'start.with.stop.on.entry': 'Start Debugging and Stop on Entry',
  'toggle.skipping.this.file': 'Toggle Skipping this File',
  'add.browser.breakpoint': 'Add Browser Breakpoint',
  'remove.browser.breakpoint': 'Remove Browser Breakpoint',
  'remove.browser.breakpoint.all': 'Remove All Browser Breakpoints',
  'trace.description': 'Configures what diagnostic output is produced.',
  'trace.boolean.description': "Trace may be set to 'true' to write diagnostic logs to the disk.",
  'trace.tags.description': 'Configures what types of logs are recorded.',
  'trace.logFile.description': 'Configures where on disk logs are written.',
  'trace.level.description': 'Configures the level of logs recorded.',
  'trace.console.description': 'Configures whether logs are also returned to the debug console.',
  'trace.stdio.description':
    'Whether to return trace data from the launched application or browser.',

  'base.cascadeTerminateToConfigurations.label':
    'A list of debug sessions which, when this debug session is terminated, will also be stopped.',

  'extensionHost.label': 'VS Code Extension Development',
  'extensionHost.launch.config.name': 'Launch Extension',
  'extensionHost.launch.env.description': 'Environment variables passed to the extension host.',
  'extensionHost.launch.runtimeExecutable.description': 'Absolute path to VS Code.',
  'extensionHost.launch.rendererDebugOptions':
    'Chrome launch options used when attaching to the renderer process, with `debugWebviews` or `debugWebWorkerHost`.',
  'extensionHost.launch.debugWebWorkerHost':
    'Configures whether we should try to attach to the web worker extension host.',
  'extensionHost.launch.debugWebviews':
    'Configures whether we should try to attach to webviews in the launched VS Code instance. **Note:** at the moment this requires the setting `"webview.experimental.useIframes": true` to work properly, and will only work in desktop VS Code.',
  'extensionHost.launch.stopOnEntry.description':
    'Automatically stop the extension host after launch.',
  'extensionHost.snippet.launch.description': 'Launch a VS Code extension in debug mode',
  'extensionHost.snippet.launch.label': 'VS Code Extension Development',

  'edge.useWebView.description':
    "(Edge (Chromium) only) When 'true', the debugger will treat the runtime executable as a host application that contains a WebView allowing you to debug the WebView script content.",

  'chrome.label': 'Chrome',
  'edge.label': 'Edge',
  'edge.launch.label': 'Edge: Launch',
  'edge.attach.label': 'Edge: Attach',
  'edge.launch.description': 'Launch Edge to debug a URL',
  'edge.attach.description': 'Attach to an instance of Edge already in debug mode',
  'chrome.launch.label': 'Chrome: Launch',
  'chrome.launch.description': 'Launch Chrome to debug a URL',
  'chrome.attach.label': 'Chrome: Attach',
  'chrome.attach.description': 'Attach to an instance of Chrome already in debug mode',
  'edge.address.description':
    'When debugging webviews, the IP address or hostname the webview is listening on. Will be automatically discovered if not set.',
  'edge.port.description':
    'When debugging webviews, the port the webview debugger is listening on. Will be automatically discovered if not set.',

  'browser.address.description': 'IP address or hostname the debugged browser is listening on.',
  'browser.launch.port.description':
    'Port for the browser to listen on. Defaults to "0", which will cause the browser to be debugged via pipes, which is generally more secure and should be chosen unless you need to attach to the browser from another tool.',
  'browser.cleanUp.description':
    'What clean-up to do after the debugging session finishes. Close only the tab being debug, vs. close the whole browser.',
  'browser.attach.port.description':
    'Port to use to remote debugging the browser, given as `--remote-debugging-port` when launching the browser.',
  'browser.baseUrl.description':
    'Base URL to resolve paths baseUrl. baseURL is trimmed when mapping URLs to the files on disk. Defaults to the launch URL domain.',
  'browser.cwd.description': 'Optional working directory for the runtime executable.',
  'browser.browserLaunchLocation.description':
    'Forces the browser to be launched in one location. In a remote workspace (through ssh or WSL, for example) this can be used to open the browser on the remote machine rather than locally.',
  'browser.browserAttachLocation.description':
    'Forces the browser to attach in one location. In a remote workspace (through ssh or WSL, for example) this can be used to attach to a browser on the remote machine rather than locally.',
  'browser.disableNetworkCache.description':
    'Controls whether to skip the network cache for each request',
  'browser.env.description': 'Optional dictionary of environment key/value pairs for the browser.',
  'browser.includeDefaultArgs.description':
    'Whether default browser launch arguments (to disable features that may make debugging harder) will be included in the launch.',
  'browser.file.description': 'A local html file to open in the browser',
  'browser.pathMapping.description':
    'A mapping of URLs/paths to local folders, to resolve scripts in the Browser to scripts on disk',
  'browser.runtimeExecutable.description':
    "Either 'canary', 'stable', 'custom' or path to the browser executable. Custom means a custom wrapper, custom build or CHROME_PATH environment variable.",
  'browser.runtimeExecutable.edge.description':
    "Either 'canary', 'stable', 'dev', 'custom' or path to the browser executable. Custom means a custom wrapper, custom build or EDGE_PATH environment variable.",
  'browser.skipFiles.description':
    'An array of file or folder names, or path globs, to skip when debugging.',
  'browser.smartStep.description':
    'Automatically step through unmapped lines in sourcemapped files. For example, code that TypeScript produces automatically when downcompiling async/await or other features.',
  'browser.sourceMapPathOverrides.description':
    'A set of mappings for rewriting the locations of source files from what the sourcemap says, to their locations on disk. See README for details.',
  'browser.sourceMaps.description': 'Use JavaScript source maps (if they exist).',
  'browser.timeout.description':
    'Retry for this number of milliseconds to connect to the browser. Default is 10000 ms.',
  'browser.url.description': 'Will search for a tab with this exact url and attach to it, if found',
  'browser.urlFilter.description':
    'Will search for a page with this url and attach to it, if found. Can have * wildcards.',
  'browser.webRoot.description':
    'This specifies the workspace absolute path to the webserver root. Used to resolve paths like `/app.js` to files on disk. Shorthand for a pathMapping for "/"',
  'node.launch.args.description': 'Command line arguments passed to the program.',
  'browser.runtimeArgs.description': 'Optional arguments passed to the runtime executable.',
  'browser.server.description':
    "Configures a web server to start up. Takes the same configuration as the 'node' launch task.",
  'browser.perScriptSourcemaps.description':
    'Whether scripts are loaded individually with unique sourcemaps containing the basename of the source file. This can be set to optimize sourcemap handling when dealing with lots of small scripts. If set to "auto", we\'ll detect known cases where this is appropriate.',
  'browser.userDataDir.description':
    'By default, the browser is launched with a separate user profile in a temp folder. Use this option to override it. Set to false to launch with your default user profile.',
  'browser.inspectUri.description':
    "Format to use to rewrite the inspectUri: It's a template string that interpolates keys in `{curlyBraces}`. Available keys are:\n" +
    ' - `url.*` is the parsed address of the running application. For instance, `{url.port}`, `{url.hostname}`\n' +
    ' - `port` is the debug port that Chrome is listening on.\n' +
    ' - `browserInspectUri` is the inspector URI on the launched browser\n' +
    ' - `browserInspectUriPath` is the path part of the inspector URI on the launched browser (e.g.: "/devtools/browser/e9ec0098-306e-472a-8133-5e42488929c2").\n' +
    ' - `wsProtocol` is the hinted websocket protocol. This is set to `wss` if the original URL is `https`, or `ws` otherwise.\n',
  'browser.restart': 'Whether to reconnect if the browser connection is closed',
  'browser.profileStartup.description':
    'If true, will start profiling soon as the process launches',
  'browser.revealPage': 'Focus Tab',
  'browser.targetSelection':
    'Whether to attach to all targets that match the URL filter ("automatic") or ask to pick one ("pick").',
  'browser.vueComponentPaths':
    "A list of file glob patterns to find `*.vue` components. By default, searches the entire workspace. This needs to be specified due to extra lookups that Vue's sourcemaps require in Vue CLI 4. You can disable this special handling by setting this to an empty array.",

  'debug.npm.script': 'Debug npm Script',
  'debug.npm.noWorkspaceFolder': 'You need to open a workspace folder to debug npm scripts.',
  'debug.npm.noScripts': 'No npm scripts found in your package.json',
  'debug.npm.parseError': 'Could not read {0}: {1}',
  'debug.npm.edit': 'Edit package.json',
  'debug.terminal.label': 'Create JavaScript Debug Terminal',
  'debug.terminal.program.description':
    'Command to run in the launched terminal. If not provided, the terminal will open without launching a program.',
  'debug.terminal.snippet.label': 'Run "npm start" in a debug terminal',
  'debug.terminal.welcome': `[JavaScript Debug Terminal](command:${Commands.CreateDebuggerTerminal})\n\nYou can use the JavaScript Debug Terminal to debug Node.js processes run on the command line.`,
  'debug.terminal.welcomeWithLink': `[JavaScript Debug Terminal](command:${Commands.CreateDebuggerTerminal})\n\nYou can use the JavaScript Debug Terminal to debug Node.js processes run on the command line.\n\n[Debug URL](command:${Commands.DebugLink})`,
  'debug.terminal.toggleAuto': 'Toggle Terminal Node.js Auto Attach',
  'debug.terminal.attach': 'Attach to Node.js Terminal Process',

  'node.pauseForSourceMap.description':
    'Whether to wait for source maps to load for each incoming script. This has a performance overhead, and might be safely disabled when running off of disk, so long as `rootPath` is not disabled.',
  'node.address.description': "TCP/IP address of process to be debugged. Default is 'localhost'.",
  'node.attach.config.name': 'Attach',
  'node.attach.processId.description': 'ID of process to attach to.',
  'node.attach.attachSpawnedProcesses.description':
    'Whether to set environment variables in the attached process to track spawned children.',
  'node.attach.attachExistingChildren.description':
    'Whether to attempt to attach to already-spawned child processes.',
  'node.console.title': 'Node Debug Console',
  'node.disableOptimisticBPs.description':
    "Don't set breakpoints in any file until a sourcemap has been loaded for that file.",
  'node.label': 'Node.js',
  'node.launch.autoAttachChildProcesses.description':
    'Attach debugger to new child processes automatically.',
  'node.launch.runtimeSourcemapPausePatterns':
    "A list of patterns at which to manually insert entrypoint breakpoints. This can be useful to give the debugger an opportunity to set breakpoints when using sourcemaps that don't exist or can't be detected before launch, such as [with the Serverless framework](https://github.com/microsoft/vscode-js-debug/issues/492).",
  'node.launch.config.name': 'Launch',
  'node.launch.console.description': 'Where to launch the debug target.',
  'node.launch.console.externalTerminal.description':
    'External terminal that can be configured via user settings',
  'node.launch.console.integratedTerminal.description': "VS Code's integrated terminal",
  'node.launch.console.internalConsole.description':
    "VS Code Debug Console (which doesn't support to read input from a program)",
  'node.launch.cwd.description':
    "Absolute path to the working directory of the program being debugged. If you've set localRoot then cwd will match that value otherwise it falls back to your workspaceFolder",
  'node.launch.env.description':
    'Environment variables passed to the program. The value `null` removes the variable from the environment.',
  'node.launch.envFile.description':
    'Absolute path to a file containing environment variable definitions.',
  'node.launch.logging.cdp': 'Path to the log file for Chrome DevTools Protocol messages',
  'node.launch.logging.dap': 'Path to the log file for Debug Adapter Protocol messages',
  'node.launch.logging': 'Logging configuration',
  'node.launch.outputCapture.description':
    'From where to capture output messages: the default debug API if set to `console`, or stdout/stderr streams if set to `std`.',
  'node.launch.program.description':
    'Absolute path to the program. Generated value is guessed by looking at package.json and opened files. Edit this attribute.',
  'node.launch.runtimeArgs.description': 'Optional arguments passed to the runtime executable.',
  'node.launch.runtimeExecutable.description':
    'Runtime to use. Either an absolute path or the name of a runtime available on the PATH. If omitted `node` is assumed.',
  'node.launch.runtimeVersion.description': 'Version of `node` runtime to use. Requires `nvm`.',
  'node.launch.useWSL.deprecation':
    "'useWSL' is deprecated and support for it will be dropped. Use the 'Remote - WSL' extension instead.",
  'node.launch.useWSL.description': 'Use Windows Subsystem for Linux.',
  'node.localRoot.description': 'Path to the local directory containing the program.',
  'node.port.description': 'Debug port to attach to. Default is 5858.',
  'node.websocket.address.description':
    'Exact websocket address to attach to. If unspecified, it will be discovered from the address and port.',
  'node.resolveSourceMapLocations.description':
    'A list of minimatch patterns for locations (folders and URLs) in which source maps can be used to resolve local files. This can be used to avoid incorrectly breaking in external source mapped code. Patterns can be prefixed with "!" to exclude them. May be set to an empty array or null to avoid restriction.',
  'node.processattach.config.name': 'Attach to Process',
  'node.remoteRoot.description': 'Absolute path to the remote directory containing the program.',
  'node.launch.restart.description':
    'Try to restart the program if it exits with a non-zero exit code.',
  'node.attach.restart.description':
    "Try to reconnect to the program if we lose connection. If set to `true`, we'll try once a second, forever. You can customize the interval and maximum number of attempts by specifying the `delay` and `maxAttempts` in an object instead.",
  'node.killBehavior.description': `Configures how debug process are killed when stopping the sesssion. Can be:

- forceful (default): forcefully tears down the process tree. Sends SIGKILL on posix, or \`taskkill.exe /F\` on Windows.
- polite: gracefully tears down the process tree. It's possible that misbehaving processes continue to run after shutdown in this way. Sends SIGTERM on posix, or \`taskkill.exe\` with no \`/F\` (force) flag on Windows.
- none: no termination will happen.`,
  'node.showAsyncStacks.description': 'Show the async calls that led to the current call stack.',
  'node.snippet.attach.description': 'Attach to a running node program',
  'node.snippet.attach.label': 'Node.js: Attach',
  'node.snippet.attachProcess.description':
    'Open process picker to select node process to attach to',
  'node.snippet.attachProcess.label': 'Node.js: Attach to Process',
  'node.attach.continueOnAttach':
    "If true, we'll automatically resume programs launched and waiting on `--inspect-brk`",
  'node.snippet.electron.description': 'Debug the Electron main process',
  'node.snippet.electron.label': 'Node.js: Electron Main',
  'node.snippet.gulp.description':
    'Debug gulp task (make sure to have a local gulp installed in your project)',
  'node.snippet.gulp.label': 'Node.js: Gulp task',
  'node.snippet.launch.description': 'Launch a node program in debug mode',
  'node.snippet.launch.label': 'Node.js: Launch Program',
  'node.snippet.mocha.description': 'Debug mocha tests',
  'node.snippet.mocha.label': 'Node.js: Mocha Tests',
  'node.snippet.nodemon.description': 'Use nodemon to relaunch a debug session on source changes',
  'node.snippet.nodemon.label': 'Node.js: Nodemon Setup',
  'node.snippet.npm.description': 'Launch a node program through an npm `debug` script',
  'node.snippet.npm.label': 'Node.js: Launch via npm',
  'node.snippet.remoteattach.description': 'Attach to the debug port of a remote node program',
  'node.snippet.remoteattach.label': 'Node.js: Attach to Remote Program',
  'node.snippet.yo.description':
    'Debug yeoman generator (install by running `npm link` in project folder)',
  'node.snippet.yo.label': 'Node.js: Yeoman generator',
  'node.sourceMapPathOverrides.description':
    'A set of mappings for rewriting the locations of source files from what the sourcemap says, to their locations on disk.',
  'node.sourceMaps.description': 'Use JavaScript source maps (if they exist).',
  'node.stopOnEntry.description': 'Automatically stop program after launch.',
  'node.timeout.description':
    'Retry for this number of milliseconds to connect to Node.js. Default is 10000 ms.',
  'node.versionHint.description':
    "Allows you to explicitly specify the Node version that's running, which can be used to disable or enable certain behaviors in cases where the automatic version detection does not working.",
  'timeouts.generalDescription': 'Timeouts for several debugger operations',
  'timeouts.generalDescription.markdown': 'Timeouts for several debugger operations',
  'timeouts.sourceMaps.description': 'Timeouts related to source maps operations',
  'timeouts.sourceMaps.sourceMapMinPause.description':
    'Minimum time in milliseconds spent waiting for each source-map to be processed when a script is being parsed',
  'timeouts.sourceMaps.sourceMapCumulativePause.description':
    'Extra time in milliseconds allowed per session to be spent waiting for source-maps to be processed, after the minimum time (sourceMapMinPause) has been exhausted',
  'node.profileStartup.description': 'If true, will start profiling soon as the process launches',
  'node.attachSimplePort.description':
    'If set, attaches to the process via the given port. This is generally no longer necessary for Node.js programs and loses the ability to debug child processes, but can be useful in more esoteric scenarios such as with Deno and Docker launches. If set to 0, a random port will be chosen and --inspect-brk added to the launch arguments automatically.',
  'enableContentValidation.description':
    'Toggles whether we verify the contents of files on disk match the ones loaded in the runtime. This is useful in a variety of scenarios and required in some, but can cause issues if you have server-side transformation of scripts, for example.',
  'customDescriptionGenerator.description': `Customize the textual description the debugger shows for objects (local variables, etc...). Samples:
      1. this.toString() // will call toString to print all objects
      2. this.customDescription ? this.customDescription() : defaultValue // Use customDescription method if available, if not return defaultValue
      3. function (def) { return this.customDescription ? this.customDescription() : def } // Use customDescription method if available, if not return defaultValue
      `,
  'customPropertiesGenerator.description': `Customize the properties shown for an object in the debugger (local variables, etc...). Samples:
    1. { ...this, extraProperty: '12345' } // Add an extraProperty 12345 to all objects
    2. this.customProperties ? this.customProperties() : this // Use customProperties method if available, if not use the properties in this (the default properties)
    3. function () { return this.customProperties ? this.customProperties() : this } // Use customDescription method if available, if not return the default properties

    Deprecated: This is a temporary implementation of this feature until we have time to implement it in the way described here: https://github.com/microsoft/vscode/issues/102181`,

  'longPredictionWarning.message':
    "It's taking a while to configure your breakpoints. You can speed this up by updating the 'outFiles' in your launch.json.",
  'longPredictionWarning.open': 'Open launch.json',
  'longPredictionWarning.disable': "Don't show again",
  'longPredictionWarning.noFolder': 'No workspace folder open.',
  'outFiles.description':
    'If source maps are enabled, these glob patterns specify the generated JavaScript files. If a pattern starts with `!` the files are excluded. If not specified, the generated code is expected in the same directory as its source.',
  'pretty.print.script': 'Pretty print for debugging',
  'skipFiles.description':
    'An array of glob patterns for files to skip when debugging. The pattern `<node_internals>/**` matches all internal Node.js modules.',
  'smartStep.description':
    'Automatically step through generated code that cannot be mapped back to the original source.',
  'errors.timeout': '{0}: timeout after {1}ms',

  'configuration.npmScriptLensLocation':
    'Where a "Run" and "Debug" code lens should be shown in your npm scripts. It may be on "all", scripts, on "top" of the script section, or "never".',
  'configuration.terminalOptions':
    'Default launch options for the JavaScript debug terminal and npm scripts.',
  'configuration.usePreview': 'Use the new in-preview JavaScript debugger for Node.js and Chrome.',
  'configuration.suggestPrettyPrinting':
    'Whether to suggest pretty printing JavaScript code that looks minified when you step into it.',
  'configuration.automaticallyTunnelRemoteServer':
    'When debugging a remote web app, configures whether to automatically tunnel the remote server to your local machine.',
  'configuration.debugByLinkOptions':
    'Options used when debugging open links clicked from inside the JavaScript Debug Terminal. Can be set to "off" to disable this behavior, or "always" to enable debugging in all terminals.',
  'configuration.pickAndAttachOptions':
    'Default options used when debugging a process through the `Debug: Attach to Node.js Process` command',
  'configuration.autoExpandGetters':
    'Configures whether property getters will be expanded automatically. If this is false, the getter will appear as `get propertyName` and will only be evaluated when you click on it.',
  'configuration.autoAttachMode':
    'Configures which processes to automatically attach and debug when `#debug.node.autoAttach#` is on. A Node process launched with the `--inspect` flag will always be attached to, regardless of this setting.',
  'configuration.autoAttachSmartPatterns':
    'Configures glob patterns for determining when to attach in "smart" `#debug.javascript.autoAttachFilter#` mode. `$KNOWN_TOOLS$` is replaced with a list of names of common test and code runners. [Read more on the VS Code docs](https://code.visualstudio.com/docs/nodejs/nodejs-debugging#_auto-attach-smart-patterns).',
  'configuration.autoAttachMode.explicit': 'Only auto attach when the `--inspect` is given.',
  'configuration.autoAttachMode.smart':
    "Auto attach when running scripts that aren't in a node_modules folder.",
  'configuration.autoAttachMode.always':
    'Auto attach to every Node.js process launched in the terminal.',
  'configuration.autoAttachMode.disabled': 'Auto attach is disabled and not shown in status bar.',
  'configuration.breakOnConditionalError':
    'Whether to stop when conditional breakpoints throw an error. Note: your launch.json `type` must be prefixed with `pwa-` to use this, such as `pwa-node`.',
  'configuration.unmapMissingSources':
    "Configures whether sourcemapped file where the original file can't be read will automatically be unmapped. If this is false (default), a prompt is shown.",
  'configuration.defaultRuntimeExecutables':
    'The default `runtimeExecutable` used for launch configurations, if unspecified. This can be used to config custom paths to Node.js or browser installations.',
  'configuration.resourceRequestOptions': `Request options to use when loading resources, such as source maps, in the debugger. You may need to configure this if your sourcemaps require authentication or use a self-signed certificate, for instance. Options are used to create a request using the [\`got\`](https://github.com/sindresorhus/got) library.

A common case to disable certificate verification can be done by passing \`{ "https": { "rejectUnauthorized": false } }\`.`,

  'profile.start': 'Take Performance Profile',
  'profile.stop': 'Stop Performance Profile',
  'debugLink.label': 'Open Link',
  'createDiagnostics.label': 'Create Diagnostic Information for Current Session',
};

export default strings;

if (require.main === module) {
  process.stdout.write(JSON.stringify(sortKeys(strings)));
}
