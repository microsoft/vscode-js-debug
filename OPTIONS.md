# Options

### pwa-node: attach

<details><h4>address</h4><p>TCP/IP address of process to be debugged. Default is &#39;localhost&#39;.</p>
<h5>Default value:</h4><pre><code>"localhost"</pre></code><h4>attachExistingChildren</h4><p>Whether to attempt to attach to already-spawned child processes.</p>
<h5>Default value:</h4><pre><code>true</pre></code><h4>autoAttachChildProcesses</h4><p>Attach debugger to new child processes automatically.</p>
<h5>Default value:</h4><pre><code>true</pre></code><h4>cascadeTerminateToConfigurations</h4><p>A list of debug sessions which, when this debug session is terminated, will also be stopped.</p>
<h5>Default value:</h4><pre><code>[]</pre></code><h4>continueOnAttach</h4><p>If true, we&#39;ll automatically resume programs launched and waiting on <code>--inspect-brk</code></p>
<h5>Default value:</h4><pre><code>false</pre></code><h4>customDescriptionGenerator</h4><p>Customize the textual description the debugger shows for objects (local variables, etc...). Samples:<br>      1. this.toString() // will call toString to print all objects<br>      2. this.customDescription ? this.customDescription() : defaultValue // Use customDescription method if available, if not return defaultValue<br>      3. function (def) { return this.customDescription ? this.customDescription() : def } // Use customDescription method if available, if not return defaultValue<br>      </p>
<h5>Default value:</h4><pre><code>undefined</pre></code><h4>cwd</h4><p>Absolute path to the working directory of the program being debugged.</p>
<h5>Default value:</h4><pre><code>"${workspaceFolder}"</pre></code><h4>enableContentValidation</h4><p>Toggles whether we verify the contents of files on disk match the ones loaded in the runtime. This is useful in a variety of scenarios and required in some, but can cause issues if you have server-side transformation of scripts, for example.</p>
<h5>Default value:</h4><pre><code>true</pre></code><h4>env</h4><p>Environment variables passed to the program. The value <code>null</code> removes the variable from the environment.</p>
<h5>Default value:</h4><pre><code>{}</pre></code><h4>envFile</h4><p>Absolute path to a file containing environment variable definitions.</p>
<h5>Default value:</h4><pre><code>null</pre></code><h4>localRoot</h4><p>Path to the local directory containing the program.</p>
<h5>Default value:</h4><pre><code>null</pre></code><h4>nodeVersionHint</h4><p>Retry for this number of milliseconds to connect to Node.js. Default is 10000 ms.</p>
<h5>Default value:</h4><pre><code>undefined</pre></code><h4>outFiles</h4><p>If source maps are enabled, these glob patterns specify the generated JavaScript files. If a pattern starts with <code>!</code> the files are excluded. If not specified, the generated code is expected in the same directory as its source.</p>
<h5>Default value:</h4><pre><code>[
  "${workspaceFolder}/**/*.js",
  "!**/node_modules/**"
]</pre></code><h4>outputCapture</h4><p>From where to capture output messages: the default debug API if set to <code>console</code>, or stdout/stderr streams if set to <code>std</code>.</p>
<h5>Default value:</h4><pre><code>"console"</pre></code><h4>pauseForSourceMap</h4><p>Whether to wait for source maps to load for each incoming script. This has a performance overhead, and might be safely disabled when running off of disk, so long as <code>rootPath</code> is not disabled.</p>
<h5>Default value:</h4><pre><code>false</pre></code><h4>port</h4><p>Debug port to attach to. Default is 5858.</p>
<h5>Default value:</h4><pre><code>9229</pre></code><h4>processId</h4><p>ID of process to attach to.</p>
<h5>Default value:</h4><pre><code>undefined</pre></code><h4>remoteRoot</h4><p>Absolute path to the remote directory containing the program.</p>
<h5>Default value:</h4><pre><code>null</pre></code><h4>resolveSourceMapLocations</h4><p>A list of minimatch patterns for locations (folders and URLs) in which source maps can be used to resolve local files. This can be used to avoid incorrectly breaking in external source mapped code. Patterns can be prefixed with &quot;!&quot; to exclude them. May be set to an empty array or null to avoid restriction.</p>
<h5>Default value:</h4><pre><code>[
  "**",
  "!**/node_modules/**"
]</pre></code><h4>restart</h4><p>Try to reconnect to the program if we lose connection. If set to <code>true</code>, we&#39;ll try once a second, forever. You can customize the interval and maximum number of attempts by specifying the <code>delay</code> and <code>maxAttempts</code> in an object instead.</p>
<h5>Default value:</h4><pre><code>false</pre></code><h4>runtimeSourcemapPausePatterns</h4><p>A list of patterns at which to manually insert entrypoint breakpoints. This can be useful to give the debugger an opportunity to set breakpoints when using sourcemaps that don&#39;t exist or can&#39;t be detected before launch, such as <a href="https://github.com/microsoft/vscode-js-debug/issues/492">with the Serverless framework</a>.</p>
<h5>Default value:</h4><pre><code>[]</pre></code><h4>showAsyncStacks</h4><p>Show the async calls that led to the current call stack.</p>
<h5>Default value:</h4><pre><code>true</pre></code><h4>skipFiles</h4><p>An array of file or folder names, or path globs, to skip when debugging.</p>
<h5>Default value:</h4><pre><code>[]</pre></code><h4>smartStep</h4><p>Automatically step through generated code that cannot be mapped back to the original source.</p>
<h5>Default value:</h4><pre><code>true</pre></code><h4>sourceMapPathOverrides</h4><p>A set of mappings for rewriting the locations of source files from what the sourcemap says, to their locations on disk.</p>
<h5>Default value:</h4><pre><code>{
  "webpack://?:*/*": "${workspaceFolder}/*",
  "webpack:///./~/*": "${workspaceFolder}/node_modules/*",
  "meteor://💻app/*": "${workspaceFolder}/*"
}</pre></code><h4>sourceMaps</h4><p>Use JavaScript source maps (if they exist).</p>
<h5>Default value:</h4><pre><code>true</pre></code><h4>timeout</h4><p>Retry for this number of milliseconds to connect to Node.js. Default is 10000 ms.</p>
<h5>Default value:</h4><pre><code>10000</pre></code><h4>timeouts</h4><p>Timeouts for several debugger operations</p>
<h5>Default value:</h4><pre><code>{}</pre></code><h4>trace</h4><p>Configures what diagnostic output is produced.</p>
<h5>Default value:</h4><pre><code>false</pre></code><h4>websocketAddress</h4><p>Exact websocket address to attach to. If unspecified, it will be discovered from the address and port.</p>
<h5>Default value:</h4><pre><code>undefined</pre></code></details>

### pwa-node: launch

<details><h4>args</h4><p>Command line arguments passed to the program.</p>
<h5>Default value:</h4><pre><code>[]</pre></code><h4>attachSimplePort</h4><p>If set, attaches to the process via the given port. This is generally no longer necessary for Node.js programs and loses the ability to debug child processes, but can be useful in more esoteric scenarios such as with Deno and Docker launches. If set to 0, a random port will be chosen and --inspect-brk added to the launch arguments automatically.</p>
<h5>Default value:</h4><pre><code>null</pre></code><h4>autoAttachChildProcesses</h4><p>Attach debugger to new child processes automatically.</p>
<h5>Default value:</h4><pre><code>true</pre></code><h4>cascadeTerminateToConfigurations</h4><p>A list of debug sessions which, when this debug session is terminated, will also be stopped.</p>
<h5>Default value:</h4><pre><code>[]</pre></code><h4>console</h4><p>Where to launch the debug target.</p>
<h5>Default value:</h4><pre><code>"internalConsole"</pre></code><h4>customDescriptionGenerator</h4><p>Customize the textual description the debugger shows for objects (local variables, etc...). Samples:<br>      1. this.toString() // will call toString to print all objects<br>      2. this.customDescription ? this.customDescription() : defaultValue // Use customDescription method if available, if not return defaultValue<br>      3. function (def) { return this.customDescription ? this.customDescription() : def } // Use customDescription method if available, if not return defaultValue<br>      </p>
<h5>Default value:</h4><pre><code>undefined</pre></code><h4>cwd</h4><p>Absolute path to the working directory of the program being debugged.</p>
<h5>Default value:</h4><pre><code>"${workspaceFolder}"</pre></code><h4>enableContentValidation</h4><p>Toggles whether we verify the contents of files on disk match the ones loaded in the runtime. This is useful in a variety of scenarios and required in some, but can cause issues if you have server-side transformation of scripts, for example.</p>
<h5>Default value:</h4><pre><code>true</pre></code><h4>env</h4><p>Environment variables passed to the program. The value <code>null</code> removes the variable from the environment.</p>
<h5>Default value:</h4><pre><code>{}</pre></code><h4>envFile</h4><p>Absolute path to a file containing environment variable definitions.</p>
<h5>Default value:</h4><pre><code>null</pre></code><h4>localRoot</h4><p>Path to the local directory containing the program.</p>
<h5>Default value:</h4><pre><code>null</pre></code><h4>nodeVersionHint</h4><p>Retry for this number of milliseconds to connect to Node.js. Default is 10000 ms.</p>
<h5>Default value:</h4><pre><code>undefined</pre></code><h4>outFiles</h4><p>If source maps are enabled, these glob patterns specify the generated JavaScript files. If a pattern starts with <code>!</code> the files are excluded. If not specified, the generated code is expected in the same directory as its source.</p>
<h5>Default value:</h4><pre><code>[
  "${workspaceFolder}/**/*.js",
  "!**/node_modules/**"
]</pre></code><h4>outputCapture</h4><p>From where to capture output messages: the default debug API if set to <code>console</code>, or stdout/stderr streams if set to <code>std</code>.</p>
<h5>Default value:</h4><pre><code>"console"</pre></code><h4>pauseForSourceMap</h4><p>Whether to wait for source maps to load for each incoming script. This has a performance overhead, and might be safely disabled when running off of disk, so long as <code>rootPath</code> is not disabled.</p>
<h5>Default value:</h4><pre><code>false</pre></code><h4>profileStartup</h4><p>If true, will start profiling soon as the process launches</p>
<h5>Default value:</h4><pre><code>false</pre></code><h4>program</h4><p>Absolute path to the program. Generated value is guessed by looking at package.json and opened files. Edit this attribute.</p>
<h5>Default value:</h4><pre><code>""</pre></code><h4>remoteRoot</h4><p>Absolute path to the remote directory containing the program.</p>
<h5>Default value:</h4><pre><code>null</pre></code><h4>resolveSourceMapLocations</h4><p>A list of minimatch patterns for locations (folders and URLs) in which source maps can be used to resolve local files. This can be used to avoid incorrectly breaking in external source mapped code. Patterns can be prefixed with &quot;!&quot; to exclude them. May be set to an empty array or null to avoid restriction.</p>
<h5>Default value:</h4><pre><code>[
  "**",
  "!**/node_modules/**"
]</pre></code><h4>restart</h4><p>Try to reconnect to the program if we lose connection. If set to <code>true</code>, we&#39;ll try once a second, forever. You can customize the interval and maximum number of attempts by specifying the <code>delay</code> and <code>maxAttempts</code> in an object instead.</p>
<h5>Default value:</h4><pre><code>false</pre></code><h4>runtimeArgs</h4><p>Optional arguments passed to the runtime executable.</p>
<h5>Default value:</h4><pre><code>[]</pre></code><h4>runtimeExecutable</h4><p>Runtime to use. Either an absolute path or the name of a runtime available on the PATH. If omitted <code>node</code> is assumed.</p>
<h5>Default value:</h4><pre><code>"node"</pre></code><h4>runtimeSourcemapPausePatterns</h4><p>A list of patterns at which to manually insert entrypoint breakpoints. This can be useful to give the debugger an opportunity to set breakpoints when using sourcemaps that don&#39;t exist or can&#39;t be detected before launch, such as <a href="https://github.com/microsoft/vscode-js-debug/issues/492">with the Serverless framework</a>.</p>
<h5>Default value:</h4><pre><code>[]</pre></code><h4>runtimeVersion</h4><p>Version of <code>node</code> runtime to use. Requires <code>nvm</code>.</p>
<h5>Default value:</h4><pre><code>"default"</pre></code><h4>showAsyncStacks</h4><p>Show the async calls that led to the current call stack.</p>
<h5>Default value:</h4><pre><code>true</pre></code><h4>skipFiles</h4><p>An array of file or folder names, or path globs, to skip when debugging.</p>
<h5>Default value:</h4><pre><code>[]</pre></code><h4>smartStep</h4><p>Automatically step through generated code that cannot be mapped back to the original source.</p>
<h5>Default value:</h4><pre><code>true</pre></code><h4>sourceMapPathOverrides</h4><p>A set of mappings for rewriting the locations of source files from what the sourcemap says, to their locations on disk.</p>
<h5>Default value:</h4><pre><code>{
  "webpack://?:*/*": "${workspaceFolder}/*",
  "webpack:///./~/*": "${workspaceFolder}/node_modules/*",
  "meteor://💻app/*": "${workspaceFolder}/*"
}</pre></code><h4>sourceMaps</h4><p>Use JavaScript source maps (if they exist).</p>
<h5>Default value:</h4><pre><code>true</pre></code><h4>stopOnEntry</h4><p>Automatically stop program after launch.</p>
<h5>Default value:</h4><pre><code>false</pre></code><h4>timeout</h4><p>Retry for this number of milliseconds to connect to Node.js. Default is 10000 ms.</p>
<h5>Default value:</h4><pre><code>10000</pre></code><h4>timeouts</h4><p>Timeouts for several debugger operations</p>
<h5>Default value:</h4><pre><code>{}</pre></code><h4>trace</h4><p>Configures what diagnostic output is produced.</p>
<h5>Default value:</h4><pre><code>false</pre></code></details>

### node-terminal: launch

<details><h4>autoAttachChildProcesses</h4><p>Attach debugger to new child processes automatically.</p>
<h5>Default value:</h4><pre><code>true</pre></code><h4>cascadeTerminateToConfigurations</h4><p>A list of debug sessions which, when this debug session is terminated, will also be stopped.</p>
<h5>Default value:</h4><pre><code>[]</pre></code><h4>command</h4><p>Command to run in the launched terminal. If not provided, the terminal will open without launching a program.</p>
<h5>Default value:</h4><pre><code>undefined</pre></code><h4>customDescriptionGenerator</h4><p>Customize the textual description the debugger shows for objects (local variables, etc...). Samples:<br>      1. this.toString() // will call toString to print all objects<br>      2. this.customDescription ? this.customDescription() : defaultValue // Use customDescription method if available, if not return defaultValue<br>      3. function (def) { return this.customDescription ? this.customDescription() : def } // Use customDescription method if available, if not return defaultValue<br>      </p>
<h5>Default value:</h4><pre><code>undefined</pre></code><h4>cwd</h4><p>Absolute path to the working directory of the program being debugged.</p>
<h5>Default value:</h4><pre><code>"${workspaceFolder}"</pre></code><h4>enableContentValidation</h4><p>Toggles whether we verify the contents of files on disk match the ones loaded in the runtime. This is useful in a variety of scenarios and required in some, but can cause issues if you have server-side transformation of scripts, for example.</p>
<h5>Default value:</h4><pre><code>true</pre></code><h4>env</h4><p>Environment variables passed to the program. The value <code>null</code> removes the variable from the environment.</p>
<h5>Default value:</h4><pre><code>{}</pre></code><h4>envFile</h4><p>Absolute path to a file containing environment variable definitions.</p>
<h5>Default value:</h4><pre><code>null</pre></code><h4>localRoot</h4><p>Path to the local directory containing the program.</p>
<h5>Default value:</h4><pre><code>null</pre></code><h4>nodeVersionHint</h4><p>Retry for this number of milliseconds to connect to Node.js. Default is 10000 ms.</p>
<h5>Default value:</h4><pre><code>undefined</pre></code><h4>outFiles</h4><p>If source maps are enabled, these glob patterns specify the generated JavaScript files. If a pattern starts with <code>!</code> the files are excluded. If not specified, the generated code is expected in the same directory as its source.</p>
<h5>Default value:</h4><pre><code>[
  "${workspaceFolder}/**/*.js",
  "!**/node_modules/**"
]</pre></code><h4>outputCapture</h4><p>From where to capture output messages: the default debug API if set to <code>console</code>, or stdout/stderr streams if set to <code>std</code>.</p>
<h5>Default value:</h4><pre><code>"console"</pre></code><h4>pauseForSourceMap</h4><p>Whether to wait for source maps to load for each incoming script. This has a performance overhead, and might be safely disabled when running off of disk, so long as <code>rootPath</code> is not disabled.</p>
<h5>Default value:</h4><pre><code>false</pre></code><h4>remoteRoot</h4><p>Absolute path to the remote directory containing the program.</p>
<h5>Default value:</h4><pre><code>null</pre></code><h4>resolveSourceMapLocations</h4><p>A list of minimatch patterns for locations (folders and URLs) in which source maps can be used to resolve local files. This can be used to avoid incorrectly breaking in external source mapped code. Patterns can be prefixed with &quot;!&quot; to exclude them. May be set to an empty array or null to avoid restriction.</p>
<h5>Default value:</h4><pre><code>[
  "**",
  "!**/node_modules/**"
]</pre></code><h4>runtimeSourcemapPausePatterns</h4><p>A list of patterns at which to manually insert entrypoint breakpoints. This can be useful to give the debugger an opportunity to set breakpoints when using sourcemaps that don&#39;t exist or can&#39;t be detected before launch, such as <a href="https://github.com/microsoft/vscode-js-debug/issues/492">with the Serverless framework</a>.</p>
<h5>Default value:</h4><pre><code>[]</pre></code><h4>showAsyncStacks</h4><p>Show the async calls that led to the current call stack.</p>
<h5>Default value:</h4><pre><code>{
  "onceBreakpointResolved": 16
}</pre></code><h4>skipFiles</h4><p>An array of file or folder names, or path globs, to skip when debugging.</p>
<h5>Default value:</h4><pre><code>[]</pre></code><h4>smartStep</h4><p>Automatically step through generated code that cannot be mapped back to the original source.</p>
<h5>Default value:</h4><pre><code>true</pre></code><h4>sourceMapPathOverrides</h4><p>A set of mappings for rewriting the locations of source files from what the sourcemap says, to their locations on disk.</p>
<h5>Default value:</h4><pre><code>{
  "webpack://?:*/*": "${workspaceFolder}/*",
  "webpack:///./~/*": "${workspaceFolder}/node_modules/*",
  "meteor://💻app/*": "${workspaceFolder}/*"
}</pre></code><h4>sourceMaps</h4><p>Use JavaScript source maps (if they exist).</p>
<h5>Default value:</h4><pre><code>true</pre></code><h4>timeout</h4><p>Retry for this number of milliseconds to connect to Node.js. Default is 10000 ms.</p>
<h5>Default value:</h4><pre><code>10000</pre></code><h4>timeouts</h4><p>Timeouts for several debugger operations</p>
<h5>Default value:</h4><pre><code>{}</pre></code><h4>trace</h4><p>Configures what diagnostic output is produced.</p>
<h5>Default value:</h4><pre><code>false</pre></code></details>

### pwa-extensionHost: launch

<details><h4>args</h4><p>Command line arguments passed to the program.</p>
<h5>Default value:</h4><pre><code>[
  "--extensionDevelopmentPath=${workspaceFolder}"
]</pre></code><h4>autoAttachChildProcesses</h4><p>Attach debugger to new child processes automatically.</p>
<h5>Default value:</h4><pre><code>false</pre></code><h4>cascadeTerminateToConfigurations</h4><p>A list of debug sessions which, when this debug session is terminated, will also be stopped.</p>
<h5>Default value:</h4><pre><code>[]</pre></code><h4>customDescriptionGenerator</h4><p>Customize the textual description the debugger shows for objects (local variables, etc...). Samples:<br>      1. this.toString() // will call toString to print all objects<br>      2. this.customDescription ? this.customDescription() : defaultValue // Use customDescription method if available, if not return defaultValue<br>      3. function (def) { return this.customDescription ? this.customDescription() : def } // Use customDescription method if available, if not return defaultValue<br>      </p>
<h5>Default value:</h4><pre><code>undefined</pre></code><h4>cwd</h4><p>Absolute path to the working directory of the program being debugged.</p>
<h5>Default value:</h4><pre><code>"${workspaceFolder}"</pre></code><h4>debugWebviews</h4><p>Configures whether we should try to attach to webviews in the launched VS Code instance. <strong>Note:</strong> at the moment this requires the setting <code>&quot;webview.experimental.useExternalEndpoint&quot;: true</code> to work properly, and will only work in desktop VS Code.</p>
<h5>Default value:</h4><pre><code>false</pre></code><h4>debugWebWorkerHost</h4><p>Configures whether we should try to attach to the web worker extension host.</p>
<h5>Default value:</h4><pre><code>false</pre></code><h4>enableContentValidation</h4><p>Toggles whether we verify the contents of files on disk match the ones loaded in the runtime. This is useful in a variety of scenarios and required in some, but can cause issues if you have server-side transformation of scripts, for example.</p>
<h5>Default value:</h4><pre><code>true</pre></code><h4>env</h4><p>Environment variables passed to the program. The value <code>null</code> removes the variable from the environment.</p>
<h5>Default value:</h4><pre><code>{}</pre></code><h4>envFile</h4><p>Absolute path to a file containing environment variable definitions.</p>
<h5>Default value:</h4><pre><code>null</pre></code><h4>localRoot</h4><p>Path to the local directory containing the program.</p>
<h5>Default value:</h4><pre><code>null</pre></code><h4>nodeVersionHint</h4><p>Retry for this number of milliseconds to connect to Node.js. Default is 10000 ms.</p>
<h5>Default value:</h4><pre><code>undefined</pre></code><h4>outFiles</h4><p>If source maps are enabled, these glob patterns specify the generated JavaScript files. If a pattern starts with <code>!</code> the files are excluded. If not specified, the generated code is expected in the same directory as its source.</p>
<h5>Default value:</h4><pre><code>[
  "${workspaceFolder}/out/**/*.js"
]</pre></code><h4>outputCapture</h4><p>From where to capture output messages: the default debug API if set to <code>console</code>, or stdout/stderr streams if set to <code>std</code>.</p>
<h5>Default value:</h4><pre><code>"console"</pre></code><h4>pauseForSourceMap</h4><p>Whether to wait for source maps to load for each incoming script. This has a performance overhead, and might be safely disabled when running off of disk, so long as <code>rootPath</code> is not disabled.</p>
<h5>Default value:</h4><pre><code>false</pre></code><h4>remoteRoot</h4><p>Absolute path to the remote directory containing the program.</p>
<h5>Default value:</h4><pre><code>null</pre></code><h4>rendererDebugOptions</h4><p>Chrome launch options used when attaching to the renderer process, with <code>debugWebviews</code> or <code>debugWebWorkerHost</code>.</p>
<h5>Default value:</h4><pre><code>{}</pre></code><h4>resolveSourceMapLocations</h4><p>A list of minimatch patterns for locations (folders and URLs) in which source maps can be used to resolve local files. This can be used to avoid incorrectly breaking in external source mapped code. Patterns can be prefixed with &quot;!&quot; to exclude them. May be set to an empty array or null to avoid restriction.</p>
<h5>Default value:</h4><pre><code>[
  "${workspaceFolder}/**",
  "!**/node_modules/**"
]</pre></code><h4>runtimeExecutable</h4><p>Absolute path to VS Code.</p>
<h5>Default value:</h4><pre><code>"${execPath}"</pre></code><h4>runtimeSourcemapPausePatterns</h4><p>A list of patterns at which to manually insert entrypoint breakpoints. This can be useful to give the debugger an opportunity to set breakpoints when using sourcemaps that don&#39;t exist or can&#39;t be detected before launch, such as <a href="https://github.com/microsoft/vscode-js-debug/issues/492">with the Serverless framework</a>.</p>
<h5>Default value:</h4><pre><code>[]</pre></code><h4>showAsyncStacks</h4><p>Show the async calls that led to the current call stack.</p>
<h5>Default value:</h4><pre><code>true</pre></code><h4>skipFiles</h4><p>An array of file or folder names, or path globs, to skip when debugging.</p>
<h5>Default value:</h4><pre><code>[]</pre></code><h4>smartStep</h4><p>Automatically step through generated code that cannot be mapped back to the original source.</p>
<h5>Default value:</h4><pre><code>true</pre></code><h4>sourceMapPathOverrides</h4><p>A set of mappings for rewriting the locations of source files from what the sourcemap says, to their locations on disk.</p>
<h5>Default value:</h4><pre><code>{
  "webpack://?:*/*": "${workspaceFolder}/*",
  "webpack:///./~/*": "${workspaceFolder}/node_modules/*",
  "meteor://💻app/*": "${workspaceFolder}/*"
}</pre></code><h4>sourceMaps</h4><p>Use JavaScript source maps (if they exist).</p>
<h5>Default value:</h4><pre><code>true</pre></code><h4>timeout</h4><p>Retry for this number of milliseconds to connect to Node.js. Default is 10000 ms.</p>
<h5>Default value:</h4><pre><code>10000</pre></code><h4>timeouts</h4><p>Timeouts for several debugger operations</p>
<h5>Default value:</h4><pre><code>{}</pre></code><h4>trace</h4><p>Configures what diagnostic output is produced.</p>
<h5>Default value:</h4><pre><code>false</pre></code></details>

### pwa-chrome: launch

<details><h4>browserLaunchLocation</h4><p>Forces the browser to be launched in one location. In a remote workspace (through ssh or WSL, for example) this can be used to open the browser on the remote machine rather than locally.</p>
<h5>Default value:</h4><pre><code>"workspace"</pre></code><h4>cascadeTerminateToConfigurations</h4><p>A list of debug sessions which, when this debug session is terminated, will also be stopped.</p>
<h5>Default value:</h4><pre><code>[]</pre></code><h4>cleanUp</h4><p>What clean-up to do after the debugging session finishes. Close only the tab being debug, vs. close the whole browser.</p>
<h5>Default value:</h4><pre><code>"wholeBrowser"</pre></code><h4>customDescriptionGenerator</h4><p>Customize the textual description the debugger shows for objects (local variables, etc...). Samples:<br>      1. this.toString() // will call toString to print all objects<br>      2. this.customDescription ? this.customDescription() : defaultValue // Use customDescription method if available, if not return defaultValue<br>      3. function (def) { return this.customDescription ? this.customDescription() : def } // Use customDescription method if available, if not return defaultValue<br>      </p>
<h5>Default value:</h4><pre><code>undefined</pre></code><h4>cwd</h4><p>Optional working directory for the runtime executable.</p>
<h5>Default value:</h4><pre><code>null</pre></code><h4>disableNetworkCache</h4><p>Controls whether to skip the network cache for each request</p>
<h5>Default value:</h4><pre><code>true</pre></code><h4>enableContentValidation</h4><p>Toggles whether we verify the contents of files on disk match the ones loaded in the runtime. This is useful in a variety of scenarios and required in some, but can cause issues if you have server-side transformation of scripts, for example.</p>
<h5>Default value:</h4><pre><code>true</pre></code><h4>env</h4><p>Optional dictionary of environment key/value pairs for the browser.</p>
<h5>Default value:</h4><pre><code>{}</pre></code><h4>file</h4><p>A local html file to open in the browser</p>
<h5>Default value:</h4><pre><code>null</pre></code><h4>includeDefaultArgs</h4><p>Whether default browser launch arguments (to disable features that may make debugging harder) will be included in the launch.</p>
<h5>Default value:</h4><pre><code>true</pre></code><h4>inspectUri</h4><p>Format to use to rewrite the inspectUri: It&#39;s a template string that interpolates keys in <code>{curlyBraces}</code>. Available keys are:<br> - <code>url.*</code> is the parsed address of the running application. For instance, <code>{url.port}</code>, <code>{url.hostname}</code><br> - <code>port</code> is the debug port that Chrome is listening on.<br> - <code>browserInspectUri</code> is the inspector URI on the launched browser<br> - <code>wsProtocol</code> is the hinted websocket protocol. This is set to <code>wss</code> if the original URL is <code>https</code>, or <code>ws</code> otherwise.<br></p>
<h5>Default value:</h4><pre><code>undefined</pre></code><h4>outFiles</h4><p>If source maps are enabled, these glob patterns specify the generated JavaScript files. If a pattern starts with <code>!</code> the files are excluded. If not specified, the generated code is expected in the same directory as its source.</p>
<h5>Default value:</h4><pre><code>[
  "${workspaceFolder}/**/*.js",
  "!**/node_modules/**"
]</pre></code><h4>outputCapture</h4><p>From where to capture output messages: the default debug API if set to <code>console</code>, or stdout/stderr streams if set to <code>std</code>.</p>
<h5>Default value:</h4><pre><code>"console"</pre></code><h4>pathMapping</h4><p>A mapping of URLs/paths to local folders, to resolve scripts in the Browser to scripts on disk</p>
<h5>Default value:</h4><pre><code>{}</pre></code><h4>pauseForSourceMap</h4><p>Whether to wait for source maps to load for each incoming script. This has a performance overhead, and might be safely disabled when running off of disk, so long as <code>rootPath</code> is not disabled.</p>
<h5>Default value:</h4><pre><code>true</pre></code><h4>port</h4><p>Port for the browser to listen on. Defaults to &quot;0&quot;, which will cause the browser to be debugged via pipes, which is generally more secure and should be chosen unless you need to attach to the browser from another tool.</p>
<h5>Default value:</h4><pre><code>0</pre></code><h4>profileStartup</h4><p>If true, will start profiling soon as the process launches</p>
<h5>Default value:</h4><pre><code>false</pre></code><h4>resolveSourceMapLocations</h4><p>A list of minimatch patterns for locations (folders and URLs) in which source maps can be used to resolve local files. This can be used to avoid incorrectly breaking in external source mapped code. Patterns can be prefixed with &quot;!&quot; to exclude them. May be set to an empty array or null to avoid restriction.</p>
<h5>Default value:</h4><pre><code>null</pre></code><h4>runtimeArgs</h4><p>Optional arguments passed to the runtime executable.</p>
<h5>Default value:</h4><pre><code>null</pre></code><h4>runtimeExecutable</h4><p>Either &#39;canary&#39;, &#39;stable&#39;, &#39;custom&#39; or path to the browser executable. Custom means a custom wrapper, custom build or CHROME_PATH environment variable.</p>
<h5>Default value:</h4><pre><code>"stable"</pre></code><h4>showAsyncStacks</h4><p>Show the async calls that led to the current call stack.</p>
<h5>Default value:</h4><pre><code>true</pre></code><h4>skipFiles</h4><p>An array of file or folder names, or path globs, to skip when debugging.</p>
<h5>Default value:</h4><pre><code>[]</pre></code><h4>smartStep</h4><p>Automatically step through generated code that cannot be mapped back to the original source.</p>
<h5>Default value:</h4><pre><code>true</pre></code><h4>sourceMapPathOverrides</h4><p>A set of mappings for rewriting the locations of source files from what the sourcemap says, to their locations on disk.</p>
<h5>Default value:</h4><pre><code>{
  "webpack://?:*/*": "${webRoot}/*",
  "webpack:///./~/*": "${webRoot}/node_modules/*",
  "meteor://💻app/*": "${webRoot}/*"
}</pre></code><h4>sourceMaps</h4><p>Use JavaScript source maps (if they exist).</p>
<h5>Default value:</h4><pre><code>true</pre></code><h4>timeout</h4><p>Retry for this number of milliseconds to connect to Node.js. Default is 10000 ms.</p>
<h5>Default value:</h4><pre><code>10000</pre></code><h4>timeouts</h4><p>Timeouts for several debugger operations</p>
<h5>Default value:</h4><pre><code>{}</pre></code><h4>trace</h4><p>Configures what diagnostic output is produced.</p>
<h5>Default value:</h4><pre><code>false</pre></code><h4>url</h4><p>Will search for a tab with this exact url and attach to it, if found</p>
<h5>Default value:</h4><pre><code>null</pre></code><h4>urlFilter</h4><p>Will search for a page with this url and attach to it, if found. Can have * wildcards.</p>
<h5>Default value:</h4><pre><code>""</pre></code><h4>userDataDir</h4><p>By default, the browser is launched with a separate user profile in a temp folder. Use this option to override it. Set to false to launch with your default user profile.</p>
<h5>Default value:</h4><pre><code>true</pre></code><h4>vueComponentPaths</h4><p>A list of file glob patterns to find <code>*.vue</code> components. By default, searches the entire workspace. This needs to be specified due to extra lookups that Vue&#39;s sourcemaps require in Vue CLI 4. You can disable this special handling by setting this to an empty array.</p>
<h5>Default value:</h4><pre><code>[
  "${workspaceFolder}/**/*.vue",
  "!**/node_modules/**"
]</pre></code><h4>webRoot</h4><p>This specifies the workspace absolute path to the webserver root. Used to resolve paths like <code>/app.js</code> to files on disk. Shorthand for a pathMapping for &quot;/&quot;</p>
<h5>Default value:</h4><pre><code>"${workspaceFolder}"</pre></code></details>

### pwa-chrome: attach

<details><h4>address</h4><p>IP address or hostname the debugged browser is listening on.</p>
<h5>Default value:</h4><pre><code>"localhost"</pre></code><h4>browserAttachLocation</h4><p>Forces the browser to attach in one location. In a remote workspace (through ssh or WSL, for example) this can be used to attach to a browser on the remote machine rather than locally.</p>
<h5>Default value:</h4><pre><code>"workspace"</pre></code><h4>cascadeTerminateToConfigurations</h4><p>A list of debug sessions which, when this debug session is terminated, will also be stopped.</p>
<h5>Default value:</h4><pre><code>[]</pre></code><h4>customDescriptionGenerator</h4><p>Customize the textual description the debugger shows for objects (local variables, etc...). Samples:<br>      1. this.toString() // will call toString to print all objects<br>      2. this.customDescription ? this.customDescription() : defaultValue // Use customDescription method if available, if not return defaultValue<br>      3. function (def) { return this.customDescription ? this.customDescription() : def } // Use customDescription method if available, if not return defaultValue<br>      </p>
<h5>Default value:</h4><pre><code>undefined</pre></code><h4>disableNetworkCache</h4><p>Controls whether to skip the network cache for each request</p>
<h5>Default value:</h4><pre><code>true</pre></code><h4>enableContentValidation</h4><p>Toggles whether we verify the contents of files on disk match the ones loaded in the runtime. This is useful in a variety of scenarios and required in some, but can cause issues if you have server-side transformation of scripts, for example.</p>
<h5>Default value:</h4><pre><code>true</pre></code><h4>inspectUri</h4><p>Format to use to rewrite the inspectUri: It&#39;s a template string that interpolates keys in <code>{curlyBraces}</code>. Available keys are:<br> - <code>url.*</code> is the parsed address of the running application. For instance, <code>{url.port}</code>, <code>{url.hostname}</code><br> - <code>port</code> is the debug port that Chrome is listening on.<br> - <code>browserInspectUri</code> is the inspector URI on the launched browser<br> - <code>wsProtocol</code> is the hinted websocket protocol. This is set to <code>wss</code> if the original URL is <code>https</code>, or <code>ws</code> otherwise.<br></p>
<h5>Default value:</h4><pre><code>undefined</pre></code><h4>outFiles</h4><p>If source maps are enabled, these glob patterns specify the generated JavaScript files. If a pattern starts with <code>!</code> the files are excluded. If not specified, the generated code is expected in the same directory as its source.</p>
<h5>Default value:</h4><pre><code>[
  "${workspaceFolder}/**/*.js",
  "!**/node_modules/**"
]</pre></code><h4>outputCapture</h4><p>From where to capture output messages: the default debug API if set to <code>console</code>, or stdout/stderr streams if set to <code>std</code>.</p>
<h5>Default value:</h4><pre><code>"console"</pre></code><h4>pathMapping</h4><p>A mapping of URLs/paths to local folders, to resolve scripts in the Browser to scripts on disk</p>
<h5>Default value:</h4><pre><code>{}</pre></code><h4>pauseForSourceMap</h4><p>Whether to wait for source maps to load for each incoming script. This has a performance overhead, and might be safely disabled when running off of disk, so long as <code>rootPath</code> is not disabled.</p>
<h5>Default value:</h4><pre><code>true</pre></code><h4>port</h4><p>Port to use to remote debugging the browser, given as <code>--remote-debugging-port</code> when launching the browser.</p>
<h5>Default value:</h4><pre><code>0</pre></code><h4>resolveSourceMapLocations</h4><p>A list of minimatch patterns for locations (folders and URLs) in which source maps can be used to resolve local files. This can be used to avoid incorrectly breaking in external source mapped code. Patterns can be prefixed with &quot;!&quot; to exclude them. May be set to an empty array or null to avoid restriction.</p>
<h5>Default value:</h4><pre><code>null</pre></code><h4>restart</h4><p>Whether to reconnect if the browser connection is closed</p>
<h5>Default value:</h4><pre><code>false</pre></code><h4>showAsyncStacks</h4><p>Show the async calls that led to the current call stack.</p>
<h5>Default value:</h4><pre><code>true</pre></code><h4>skipFiles</h4><p>An array of file or folder names, or path globs, to skip when debugging.</p>
<h5>Default value:</h4><pre><code>[]</pre></code><h4>smartStep</h4><p>Automatically step through generated code that cannot be mapped back to the original source.</p>
<h5>Default value:</h4><pre><code>true</pre></code><h4>sourceMapPathOverrides</h4><p>A set of mappings for rewriting the locations of source files from what the sourcemap says, to their locations on disk.</p>
<h5>Default value:</h4><pre><code>{
  "webpack://?:*/*": "${webRoot}/*",
  "webpack:///./~/*": "${webRoot}/node_modules/*",
  "meteor://💻app/*": "${webRoot}/*"
}</pre></code><h4>sourceMaps</h4><p>Use JavaScript source maps (if they exist).</p>
<h5>Default value:</h4><pre><code>true</pre></code><h4>targetSelection</h4><p>Whether to attach to all targets that match the URL filter (&quot;automatic&quot;) or ask to pick one (&quot;pick&quot;).</p>
<h5>Default value:</h4><pre><code>"automatic"</pre></code><h4>timeout</h4><p>Retry for this number of milliseconds to connect to Node.js. Default is 10000 ms.</p>
<h5>Default value:</h4><pre><code>10000</pre></code><h4>timeouts</h4><p>Timeouts for several debugger operations</p>
<h5>Default value:</h4><pre><code>{}</pre></code><h4>trace</h4><p>Configures what diagnostic output is produced.</p>
<h5>Default value:</h4><pre><code>false</pre></code><h4>url</h4><p>Will search for a tab with this exact url and attach to it, if found</p>
<h5>Default value:</h4><pre><code>null</pre></code><h4>urlFilter</h4><p>Will search for a page with this url and attach to it, if found. Can have * wildcards.</p>
<h5>Default value:</h4><pre><code>""</pre></code><h4>vueComponentPaths</h4><p>A list of file glob patterns to find <code>*.vue</code> components. By default, searches the entire workspace. This needs to be specified due to extra lookups that Vue&#39;s sourcemaps require in Vue CLI 4. You can disable this special handling by setting this to an empty array.</p>
<h5>Default value:</h4><pre><code>[
  "${workspaceFolder}/**/*.vue",
  "!**/node_modules/**"
]</pre></code><h4>webRoot</h4><p>This specifies the workspace absolute path to the webserver root. Used to resolve paths like <code>/app.js</code> to files on disk. Shorthand for a pathMapping for &quot;/&quot;</p>
<h5>Default value:</h4><pre><code>"${workspaceFolder}"</pre></code></details>

### pwa-msedge: launch

<details><h4>address</h4><p>When debugging webviews, the IP address or hostname the webview is listening on. Will be automatically discovered if not set.</p>
<h5>Default value:</h4><pre><code>"localhost"</pre></code><h4>browserLaunchLocation</h4><p>Forces the browser to be launched in one location. In a remote workspace (through ssh or WSL, for example) this can be used to open the browser on the remote machine rather than locally.</p>
<h5>Default value:</h4><pre><code>"workspace"</pre></code><h4>cascadeTerminateToConfigurations</h4><p>A list of debug sessions which, when this debug session is terminated, will also be stopped.</p>
<h5>Default value:</h4><pre><code>[]</pre></code><h4>cleanUp</h4><p>What clean-up to do after the debugging session finishes. Close only the tab being debug, vs. close the whole browser.</p>
<h5>Default value:</h4><pre><code>"wholeBrowser"</pre></code><h4>customDescriptionGenerator</h4><p>Customize the textual description the debugger shows for objects (local variables, etc...). Samples:<br>      1. this.toString() // will call toString to print all objects<br>      2. this.customDescription ? this.customDescription() : defaultValue // Use customDescription method if available, if not return defaultValue<br>      3. function (def) { return this.customDescription ? this.customDescription() : def } // Use customDescription method if available, if not return defaultValue<br>      </p>
<h5>Default value:</h4><pre><code>undefined</pre></code><h4>cwd</h4><p>Optional working directory for the runtime executable.</p>
<h5>Default value:</h4><pre><code>null</pre></code><h4>disableNetworkCache</h4><p>Controls whether to skip the network cache for each request</p>
<h5>Default value:</h4><pre><code>true</pre></code><h4>enableContentValidation</h4><p>Toggles whether we verify the contents of files on disk match the ones loaded in the runtime. This is useful in a variety of scenarios and required in some, but can cause issues if you have server-side transformation of scripts, for example.</p>
<h5>Default value:</h4><pre><code>true</pre></code><h4>env</h4><p>Optional dictionary of environment key/value pairs for the browser.</p>
<h5>Default value:</h4><pre><code>{}</pre></code><h4>file</h4><p>A local html file to open in the browser</p>
<h5>Default value:</h4><pre><code>null</pre></code><h4>includeDefaultArgs</h4><p>Whether default browser launch arguments (to disable features that may make debugging harder) will be included in the launch.</p>
<h5>Default value:</h4><pre><code>true</pre></code><h4>inspectUri</h4><p>Format to use to rewrite the inspectUri: It&#39;s a template string that interpolates keys in <code>{curlyBraces}</code>. Available keys are:<br> - <code>url.*</code> is the parsed address of the running application. For instance, <code>{url.port}</code>, <code>{url.hostname}</code><br> - <code>port</code> is the debug port that Chrome is listening on.<br> - <code>browserInspectUri</code> is the inspector URI on the launched browser<br> - <code>wsProtocol</code> is the hinted websocket protocol. This is set to <code>wss</code> if the original URL is <code>https</code>, or <code>ws</code> otherwise.<br></p>
<h5>Default value:</h4><pre><code>undefined</pre></code><h4>outFiles</h4><p>If source maps are enabled, these glob patterns specify the generated JavaScript files. If a pattern starts with <code>!</code> the files are excluded. If not specified, the generated code is expected in the same directory as its source.</p>
<h5>Default value:</h4><pre><code>[
  "${workspaceFolder}/**/*.js",
  "!**/node_modules/**"
]</pre></code><h4>outputCapture</h4><p>From where to capture output messages: the default debug API if set to <code>console</code>, or stdout/stderr streams if set to <code>std</code>.</p>
<h5>Default value:</h4><pre><code>"console"</pre></code><h4>pathMapping</h4><p>A mapping of URLs/paths to local folders, to resolve scripts in the Browser to scripts on disk</p>
<h5>Default value:</h4><pre><code>{}</pre></code><h4>pauseForSourceMap</h4><p>Whether to wait for source maps to load for each incoming script. This has a performance overhead, and might be safely disabled when running off of disk, so long as <code>rootPath</code> is not disabled.</p>
<h5>Default value:</h4><pre><code>true</pre></code><h4>port</h4><p>When debugging webviews, the port the webview debugger is listening on. Will be automatically discovered if not set.</p>
<h5>Default value:</h4><pre><code>0</pre></code><h4>profileStartup</h4><p>If true, will start profiling soon as the process launches</p>
<h5>Default value:</h4><pre><code>false</pre></code><h4>resolveSourceMapLocations</h4><p>A list of minimatch patterns for locations (folders and URLs) in which source maps can be used to resolve local files. This can be used to avoid incorrectly breaking in external source mapped code. Patterns can be prefixed with &quot;!&quot; to exclude them. May be set to an empty array or null to avoid restriction.</p>
<h5>Default value:</h4><pre><code>null</pre></code><h4>runtimeArgs</h4><p>Optional arguments passed to the runtime executable.</p>
<h5>Default value:</h4><pre><code>null</pre></code><h4>runtimeExecutable</h4><p>Either &#39;canary&#39;, &#39;stable&#39;, &#39;dev&#39;, &#39;custom&#39; or path to the browser executable. Custom means a custom wrapper, custom build or EDGE_PATH environment variable.</p>
<h5>Default value:</h4><pre><code>"stable"</pre></code><h4>showAsyncStacks</h4><p>Show the async calls that led to the current call stack.</p>
<h5>Default value:</h4><pre><code>true</pre></code><h4>skipFiles</h4><p>An array of file or folder names, or path globs, to skip when debugging.</p>
<h5>Default value:</h4><pre><code>[]</pre></code><h4>smartStep</h4><p>Automatically step through generated code that cannot be mapped back to the original source.</p>
<h5>Default value:</h4><pre><code>true</pre></code><h4>sourceMapPathOverrides</h4><p>A set of mappings for rewriting the locations of source files from what the sourcemap says, to their locations on disk.</p>
<h5>Default value:</h4><pre><code>{
  "webpack://?:*/*": "${webRoot}/*",
  "webpack:///./~/*": "${webRoot}/node_modules/*",
  "meteor://💻app/*": "${webRoot}/*"
}</pre></code><h4>sourceMaps</h4><p>Use JavaScript source maps (if they exist).</p>
<h5>Default value:</h4><pre><code>true</pre></code><h4>timeout</h4><p>Retry for this number of milliseconds to connect to Node.js. Default is 10000 ms.</p>
<h5>Default value:</h4><pre><code>10000</pre></code><h4>timeouts</h4><p>Timeouts for several debugger operations</p>
<h5>Default value:</h4><pre><code>{}</pre></code><h4>trace</h4><p>Configures what diagnostic output is produced.</p>
<h5>Default value:</h4><pre><code>false</pre></code><h4>url</h4><p>Will search for a tab with this exact url and attach to it, if found</p>
<h5>Default value:</h4><pre><code>null</pre></code><h4>urlFilter</h4><p>Will search for a page with this url and attach to it, if found. Can have * wildcards.</p>
<h5>Default value:</h4><pre><code>""</pre></code><h4>userDataDir</h4><p>By default, the browser is launched with a separate user profile in a temp folder. Use this option to override it. Set to false to launch with your default user profile.</p>
<h5>Default value:</h4><pre><code>true</pre></code><h4>useWebView</h4><p>(Edge (Chromium) only) When &#39;true&#39;, the debugger will treat the runtime executable as a host application that contains a WebView allowing you to debug the WebView script content.</p>
<h5>Default value:</h4><pre><code>false</pre></code><h4>vueComponentPaths</h4><p>A list of file glob patterns to find <code>*.vue</code> components. By default, searches the entire workspace. This needs to be specified due to extra lookups that Vue&#39;s sourcemaps require in Vue CLI 4. You can disable this special handling by setting this to an empty array.</p>
<h5>Default value:</h4><pre><code>[
  "${workspaceFolder}/**/*.vue",
  "!**/node_modules/**"
]</pre></code><h4>webRoot</h4><p>This specifies the workspace absolute path to the webserver root. Used to resolve paths like <code>/app.js</code> to files on disk. Shorthand for a pathMapping for &quot;/&quot;</p>
<h5>Default value:</h4><pre><code>"${workspaceFolder}"</pre></code></details>

### pwa-msedge: attach

<details><h4>address</h4><p>IP address or hostname the debugged browser is listening on.</p>
<h5>Default value:</h4><pre><code>"localhost"</pre></code><h4>browserAttachLocation</h4><p>Forces the browser to attach in one location. In a remote workspace (through ssh or WSL, for example) this can be used to attach to a browser on the remote machine rather than locally.</p>
<h5>Default value:</h4><pre><code>"workspace"</pre></code><h4>cascadeTerminateToConfigurations</h4><p>A list of debug sessions which, when this debug session is terminated, will also be stopped.</p>
<h5>Default value:</h4><pre><code>[]</pre></code><h4>customDescriptionGenerator</h4><p>Customize the textual description the debugger shows for objects (local variables, etc...). Samples:<br>      1. this.toString() // will call toString to print all objects<br>      2. this.customDescription ? this.customDescription() : defaultValue // Use customDescription method if available, if not return defaultValue<br>      3. function (def) { return this.customDescription ? this.customDescription() : def } // Use customDescription method if available, if not return defaultValue<br>      </p>
<h5>Default value:</h4><pre><code>undefined</pre></code><h4>disableNetworkCache</h4><p>Controls whether to skip the network cache for each request</p>
<h5>Default value:</h4><pre><code>true</pre></code><h4>enableContentValidation</h4><p>Toggles whether we verify the contents of files on disk match the ones loaded in the runtime. This is useful in a variety of scenarios and required in some, but can cause issues if you have server-side transformation of scripts, for example.</p>
<h5>Default value:</h4><pre><code>true</pre></code><h4>inspectUri</h4><p>Format to use to rewrite the inspectUri: It&#39;s a template string that interpolates keys in <code>{curlyBraces}</code>. Available keys are:<br> - <code>url.*</code> is the parsed address of the running application. For instance, <code>{url.port}</code>, <code>{url.hostname}</code><br> - <code>port</code> is the debug port that Chrome is listening on.<br> - <code>browserInspectUri</code> is the inspector URI on the launched browser<br> - <code>wsProtocol</code> is the hinted websocket protocol. This is set to <code>wss</code> if the original URL is <code>https</code>, or <code>ws</code> otherwise.<br></p>
<h5>Default value:</h4><pre><code>undefined</pre></code><h4>outFiles</h4><p>If source maps are enabled, these glob patterns specify the generated JavaScript files. If a pattern starts with <code>!</code> the files are excluded. If not specified, the generated code is expected in the same directory as its source.</p>
<h5>Default value:</h4><pre><code>[
  "${workspaceFolder}/**/*.js",
  "!**/node_modules/**"
]</pre></code><h4>outputCapture</h4><p>From where to capture output messages: the default debug API if set to <code>console</code>, or stdout/stderr streams if set to <code>std</code>.</p>
<h5>Default value:</h4><pre><code>"console"</pre></code><h4>pathMapping</h4><p>A mapping of URLs/paths to local folders, to resolve scripts in the Browser to scripts on disk</p>
<h5>Default value:</h4><pre><code>{}</pre></code><h4>pauseForSourceMap</h4><p>Whether to wait for source maps to load for each incoming script. This has a performance overhead, and might be safely disabled when running off of disk, so long as <code>rootPath</code> is not disabled.</p>
<h5>Default value:</h4><pre><code>true</pre></code><h4>port</h4><p>Port to use to remote debugging the browser, given as <code>--remote-debugging-port</code> when launching the browser.</p>
<h5>Default value:</h4><pre><code>0</pre></code><h4>resolveSourceMapLocations</h4><p>A list of minimatch patterns for locations (folders and URLs) in which source maps can be used to resolve local files. This can be used to avoid incorrectly breaking in external source mapped code. Patterns can be prefixed with &quot;!&quot; to exclude them. May be set to an empty array or null to avoid restriction.</p>
<h5>Default value:</h4><pre><code>null</pre></code><h4>restart</h4><p>Whether to reconnect if the browser connection is closed</p>
<h5>Default value:</h4><pre><code>false</pre></code><h4>showAsyncStacks</h4><p>Show the async calls that led to the current call stack.</p>
<h5>Default value:</h4><pre><code>true</pre></code><h4>skipFiles</h4><p>An array of file or folder names, or path globs, to skip when debugging.</p>
<h5>Default value:</h4><pre><code>[]</pre></code><h4>smartStep</h4><p>Automatically step through generated code that cannot be mapped back to the original source.</p>
<h5>Default value:</h4><pre><code>true</pre></code><h4>sourceMapPathOverrides</h4><p>A set of mappings for rewriting the locations of source files from what the sourcemap says, to their locations on disk.</p>
<h5>Default value:</h4><pre><code>{
  "webpack://?:*/*": "${webRoot}/*",
  "webpack:///./~/*": "${webRoot}/node_modules/*",
  "meteor://💻app/*": "${webRoot}/*"
}</pre></code><h4>sourceMaps</h4><p>Use JavaScript source maps (if they exist).</p>
<h5>Default value:</h4><pre><code>true</pre></code><h4>targetSelection</h4><p>Whether to attach to all targets that match the URL filter (&quot;automatic&quot;) or ask to pick one (&quot;pick&quot;).</p>
<h5>Default value:</h4><pre><code>"automatic"</pre></code><h4>timeout</h4><p>Retry for this number of milliseconds to connect to Node.js. Default is 10000 ms.</p>
<h5>Default value:</h4><pre><code>10000</pre></code><h4>timeouts</h4><p>Timeouts for several debugger operations</p>
<h5>Default value:</h4><pre><code>{}</pre></code><h4>trace</h4><p>Configures what diagnostic output is produced.</p>
<h5>Default value:</h4><pre><code>false</pre></code><h4>url</h4><p>Will search for a tab with this exact url and attach to it, if found</p>
<h5>Default value:</h4><pre><code>null</pre></code><h4>urlFilter</h4><p>Will search for a page with this url and attach to it, if found. Can have * wildcards.</p>
<h5>Default value:</h4><pre><code>""</pre></code><h4>useWebView</h4><p>(Edge (Chromium) only) When &#39;true&#39;, the debugger will treat the runtime executable as a host application that contains a WebView allowing you to debug the WebView script content.</p>
<h5>Default value:</h4><pre><code>false</pre></code><h4>vueComponentPaths</h4><p>A list of file glob patterns to find <code>*.vue</code> components. By default, searches the entire workspace. This needs to be specified due to extra lookups that Vue&#39;s sourcemaps require in Vue CLI 4. You can disable this special handling by setting this to an empty array.</p>
<h5>Default value:</h4><pre><code>[
  "${workspaceFolder}/**/*.vue",
  "!**/node_modules/**"
]</pre></code><h4>webRoot</h4><p>This specifies the workspace absolute path to the webserver root. Used to resolve paths like <code>/app.js</code> to files on disk. Shorthand for a pathMapping for &quot;/&quot;</p>
<h5>Default value:</h4><pre><code>"${workspaceFolder}"</pre></code></details>
