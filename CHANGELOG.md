# Changelog

This changelog records changes to stable releases since 1.50.2. "TBA" changes here may be available in the [nightly release](https://github.com/microsoft/vscode-js-debug/#nightly-extension) before they're in stable. Note that the minor version (`v1.X.0`) corresponds to the VS Code version js-debug is shipped in, but the patch version (`v1.50.X`) is not meaningful.

## Nightly (only)

- feat: support providing terminal args as a string to avoid escaping ([#1335](https://github.com/microsoft/vscode-js-debug/issues/1335))
- fix: performance improvements for setting breakpoints in large projects ([vscode#153470](https://github.com/microsoft/vscode/issues/153470))
- fix: completions not returning stack variables ([vscode#153651](https://github.com/microsoft/vscode/issues/153651))
- fix: react native windows direct debugging not showing variables ([vscode#154976](https://github.com/microsoft/vscode/issues/154976))
- fix: previews showing in some cases `[object Object]` ([#1338](https://github.com/microsoft/vscode-js-debug/issues/1338))

## v1.69 (June 2022)

### v1.69.0 - 2022-06-27

- feat: simplify pretty print to align with devtools ([vscode#151410](https://github.com/microsoft/vscode/issues/151410))
- feat: add a new **Debug: Save Diagnostic JS Debug Logs** command ([#1301](https://github.com/microsoft/vscode-js-debug/issues/1301))
- feat: use custom `toString()` methods to generate object descriptions ([#1284](https://github.com/microsoft/vscode-js-debug/issues/1284))
- feat: allow easy toggling between compiled and sourcemapped sources ([vscode#151412](https://github.com/microsoft/vscode/issues/151412))
- feat: implement step in targets ([vscode#123879](https://github.com/microsoft/vscode/issues/123879))
- fix: debugged child processes in ext host causing teardown ([#1289](https://github.com/microsoft/vscode-js-debug/issues/1289))
- fix: errors thrown in process tree lookup not being visible ([vscode#150754](https://github.com/microsoft/vscode/issues/150754))
- fix: extension debugging not working with two ipv6 interfaces ([vscode#144315](https://github.com/microsoft/vscode/issues/144315))
- fix: rare freezes if browsers logged information to stdout
- chore: adopt new restartFrame semantics from Chrome 104 ([#1283](https://github.com/microsoft/vscode-js-debug/issues/1283))

## v1.68 (May 2022)

### v1.68.0 - 2022-05-30

- chore: support new sha script hashes from chrome ([#1244](https://github.com/microsoft/vscode-js-debug/issues/1244))
- fix: bigint value previews not working in some cases ([#1277](https://github.com/microsoft/vscode-js-debug/issues/1277))
- fix: snap versions in alternate install locations resulting in warning ([#1239](https://github.com/microsoft/vscode-js-debug/issues/1239))
- fix: align hoverEvaluation config suggestion with actual default
- fix: remove query strings from sourcemapped URLs ([#1225](https://github.com/microsoft/vscode-js-debug/issues/1225))
- fix: prefer to parse source map directly before failling back to path mapping ([vscode#148864](https://github.com/microsoft/vscode/issues/148864))
- fix: only enter debug mode on f11 when debug view is visible ([vscode#141157](https://github.com/microsoft/vscode/issues/141157))

## v1.67 (April 2022)

### v1.67.2 - 2022-04-29

- fix: data URI sourcemaps not loading

### v1.67.1 - 2022-04-28

- fix: debug not working on Node 12 or lower

### v1.67.0 - 2022-04-26

- feat: apply pathMapping when loading sourcemaps ([#1240](https://github.com/microsoft/vscode-js-debug/issues/1240))
- feat: apply pathMapping when loading sourcemaps ([#1242](https://github.com/microsoft/vscode-js-debug/issues/1242))
- fix: sourcemap renames replacing in invalid contexts ([#1201](https://github.com/microsoft/vscode-js-debug/issues/1201))

## v1.66 (March 2022)

### v1.66.1 - 2022-03-24

- feat: adopt `CompletionItem.detail` ([vscode#145645](https://github.com/microsoft/vscode/issues/145645))
- feat: support for debugging webviews in UWPs ([#1209](https://github.com/microsoft/vscode-js-debug/issues/1209))
- fix: accessor properties not being writable ([vscode#146001](https://github.com/microsoft/vscode/issues/146001))
- fix: completions sometimes throwing issue on accessor ([#1218](https://github.com/microsoft/vscode-js-debug/issues/1218))

### v1.66.0 - 2022-03-03

- feat: add heap profiler
- fix: properly support DAP `valueFormat` ([#1188](https://github.com/microsoft/vscode-js-debug/issues/1188))
- fix: don't use `pwa-` prefixed launch types in snippets ([#1138](https://github.com/microsoft/vscode-js-debug/issues/1138))
- fix: readonly attribute not being applied to getter values ([vscode#143790](https://github.com/microsoft/vscode/issues/143790))
- fix: cwd being lost causing resolution errors in auto attach ([#1212](https://github.com/microsoft/vscode-js-debug/issues/1212))
- fix: avoid nesting `localRoot`'s in programmatic starts ([#1140](https://github.com/microsoft/vscode-js-debug/issues/1140))
- fix: icon in "stop profiling" button not spinning ([vscode#136742](https://github.com/microsoft/vscode/issues/136742))
- refactor: simplify and improve browser connection in WSL and remotes

## v1.65 (February 2022)

### v1.65.0 - 2022-02-23

- feat: adopt `isTransient` to avoid persisting debug terminal ([#1196](https://github.com/microsoft/vscode-js-debug/issues/1196))
- feat: adopt new presentationHint.lazy for getters ([#1211](https://github.com/microsoft/vscode-js-debug/issues/1211))
- fix: don't use `pwa-` prefixed launch types in snippets ([#1138](https://github.com/microsoft/vscode-js-debug/issues/1138))
- fix: logpoints causing pauses if console.log returns truthy ([#1191](https://github.com/microsoft/vscode-js-debug/issues/1191))
- fix: handle query string and path fragments in `file`s within the launch config ([vscode#142199](https://github.com/microsoft/vscode/issues/142199))
- fix: do not narrow outFiles within the workspace folder automatically ([vscode#142641](https://github.com/microsoft/vscode/issues/142641))
- fix: improve formatting of errors in output ([vscode#122870](https://github.com/microsoft/vscode/issues/122870))
- fix: improve labels in Excluded Caller view ([vscode#141669](https://github.com/microsoft/vscode/issues/141669))
- refactor: remove usage of `Debugger.callFrame.url` ([#1136](https://github.com/microsoft/vscode-js-debug/issues/1136))
- refactor: clean debt around output, fix previews not updating on memory changes

## v1.64 (January 2022)

### v1.64.3 - 2022-02-08

- fix: blazor attachment not working ([#1190](https://github.com/microsoft/vscode-js-debug/issues/1190))

### v1.64.2 - 2022-01-27

- fix: excluded callers not working consistently

### v1.64.1 - 2022-01-25

- fix: excluded callers not updating during same session
- fix: capitalization of label in exclude callers ([vscode#141454](https://github.com/microsoft/vscode/issues/141454))
- fix: respect bytesOffset/byteLength when reading/writing memory ([vscode#141449](https://github.com/microsoft/vscode/issues/141449))

### v1.64.0 - 2022-01-24

- feat: support debugging Edge on Linux ([vscode#138495](https://github.com/microsoft/vscode/issues/138495))
- feat: support readMemory/writeMemory requests ([#1167](https://github.com/microsoft/vscode/issues/1167))
- feat: copy binary types better ([#1168](https://github.com/microsoft/vscode-js-debug/issues/1168))
- feat: add excluded callers ([vscode#127775](https://github.com/microsoft/vscode/issues/127775))
- fix: use default NVM directory if NVM_DIR is not set ([vscode#133521](https://github.com/microsoft/vscode/issues/133521))
- fix: lines offset when debugging web worker extensions ([vscode#136242](https://github.com/microsoft/vscode/issues/136242))
- fix: "copy as expression" and "add to watch" for private fields ([vscode#135944](https://github.com/microsoft/vscode/issues/135944))
- fix: `autoAttachChildProcesses` in extension host sometimes not working ([#1134](https://github.com/microsoft/vscode-js-debug/issues/1134))
- fix: improve sourcemap resolution when code is outside of the workspaceFolder ([vscode#139086](https://github.com/microsoft/vscode/issues/139086))
- fix: automatically try 127.0.0.1 if requests to localhost fail ([vscode#140536](https://github.com/microsoft/vscode/issues/140536))
- fix: make node process regex more permissive ([vscode#137084](https://github.com/microsoft/vscode/issues/137084))
- fix: breakpoints in paths with URI component entities not binding ([#1174](https://github.com/microsoft/vscode-js-debug/issues/1174))

## v1.62 (October 2021)

### v1.62.0 - 2021-10-26

- feat: allow multiline values in envFiles ([#1116](https://github.com/microsoft/vscode-js-debug/issues/1116))
- feat: rewrite old `.scripts` command to new diagnostic tool
- feat: sort non-enumerable properties to match Chrome devtools ([vscode#73061](https://github.com/microsoft/vscode/issues/73061))
- fix: update path handling when debugging vscode webviews ([vscode#133867](https://github.com/microsoft/vscode/issues/133867))
- fix: allow webpacked path with special characters to map ([#1080](https://github.com/microsoft/vscode-js-debug/issues/1080))
- fix: provide explicit warning if cwd is invalid ([vscode#133310](https://github.com/microsoft/vscode/issues/133310))
- fix: don't change url when restarting the debug session ([#1103](https://github.com/microsoft/vscode-js-debug/issues/1103))
- fix: breakpoint diagnostic tool not working
- fix: use proper default resolution for sourceMapPathOverrides for node-terminal ([vscode#114076](https://github.com/microsoft/vscode/issues/114076))
- fix: private class fields not working in repl ([#1113](https://github.com/microsoft/vscode-js-debug/issues/1113))
- chore: update docstring on `debugWebviews` ([#1127](https://github.com/microsoft/vscode-js-debug/issues/1127))

## v1.61 (September 2021)

### v1.61.0 - 2021-09-28

- fix: sourcemap locations not resolving on remotes ([vscode#131729](https://github.com/microsoft/vscode/issues/131729))
- fix: remove redundant `__proto__` prop on recent V8 versions ([vscode#130365](https://github.com/microsoft/vscode/issues/130365))
- fix: debug ports being auto forwarded after detach ([#1092](https://github.com/microsoft/vscode-js-debug/issues/1092))
- fix: don't incorrectly scope sourcemap resolution to node_modules ([#1100](https://github.com/microsoft/vscode-js-debug/issues/1100))
- fix: sourcemaps not working in preloads in older Electron versions ([#1099](https://github.com/microsoft/vscode-js-debug/issues/1099))
- fix: duplicate entries in launch.json creator ([vscode#132932](https://github.com/microsoft/vscode/issues/132932))
- feat: add node_internals to skipFiles by default ([#1091](https://github.com/microsoft/vscode-js-debug/issues/1091))
- feat: allow using a .ps1 script as a runtimeExectuable ([#1093](https://github.com/microsoft/vscode-js-debug/issues/1093))
- feat: avoid attaching to scripts in .rc files ([vscode#127717](https://github.com/microsoft/vscode/issues/127717))

## v1.60 (August 2021)

### v1.60.1 - 2021-08-23

- fix: fall back to any installed browser version if stable is not available ([vscode#129013](https://github.com/microsoft/vscode/issues/129013))
- fix: workspaceFolder error in workspace launch configs ([vscode#128922](https://github.com/microsoft/vscode/issues/128922))
- fix: console logs being slow when run without debugging ([#1068](https://github.com/microsoft/vscode-js-debug/issues/1068))
- fix: not pausing on unhandled promise rejections ([vscode#130265](https://github.com/microsoft/vscode/issues/130265))
- feat: support setExpression for updating WATCH view variables ([#1075](https://github.com/microsoft/vscode-js-debug/issues/1075))
- feat: integrate skipFiles with smartStepping to step through blackbox failures ([#1085](https://github.com/microsoft/vscode-js-debug/issues/1085))
- fix: extension host not always being torn down when stopping debugging ([vscode#126911](https://github.com/microsoft/vscode/issues/126911))
- fix: args list not updating when session is restarted ([vscode#128058](https://github.com/microsoft/vscode/issues/128058))

### v1.60.0 - 2021-08-03

- chore: take ownership of the default launch types ([#1065](https://github.com/microsoft/vscode-js-debug/issues/1065))
- fix: apply electron updates for debugging vscode webviews ([vscode#128637](https://github.com/microsoft/vscode/issues/128637))

## v1.59 (July 2021)

### v1.59.0 - 2021-07-27

- feat: support $returnValue in conditional breakpoints ([vscode#129328](https://github.com/microsoft/vscode/issues/129328))
- fix: pausing on first line of worker_thread when created with empty env ([vscode#125451](https://github.com/microsoft/vscode/issues/125451))
- fix: exclude electron from chrome attach reload ([#1058](https://github.com/microsoft/vscode-js-debug/issues/1058))
- fix: retry websocket connections instead of waiting for timeout
- chore: adopt new terminal icon

## v1.58 (June 2021)

### v1.58.2 - 2021-07-01

- fix: breakpoints not being set when debugging file uris ([#1035](https://github.com/microsoft/vscode-js-debug/issues/1035))

### v1.58.1 - 2021-06-30

- feat: allow disabling sourcemap renames ([#1033](https://github.com/microsoft/vscode-js-debug/issues/1033))
- fix: show welcome view for all common languages ([#1039](https://github.com/microsoft/vscode-js-debug/issues/1039))
- fix: apply skipFile exception checking for promise rejections

### v1.58.0 - 2021-06-16

- feat: reload page on attached restart ([#1004](https://github.com/microsoft/vscode-js-debug/issues/1004))
- feat: allow taking heap snapshots with profiler ([#1031](https://github.com/microsoft/vscode-js-debug/issues/1031))
- fix: default F5 not working on files outside workspace ([vscode#125796](https://github.com/microsoft/vscode/issues/125796))
- fix: debugging with no launch config fails when tsc task detection is disabled ([vscode#69572](https://github.com/microsoft/vscode/issues/69572))
- fix: race causing lost sessions when attaching to many concurrent processes in the debug terminal ([vscode#124060](https://github.com/microsoft/vscode/issues/124060))
- fix: pathMapping not working if url in browser launch is undefined ([#1003](https://github.com/microsoft/vscode-js-debug/issues/1003))
- fix: error when trying to set a breakpoint in index.html ([#1028](https://github.com/microsoft/vscode-js-debug/issues/1028))
- fix: only request source content for sourcemaps with renames ([#1033](https://github.com/microsoft/vscode-js-debug/issues/1033))
- chore: update terminal profile contributions ([vscode#120369](https://github.com/microsoft/vscode/issues/120369))

## v1.57 (May 2021)

### v1.57.0 - 2021-06-02

- feat: support renamed sourcemap identifiers ([vscode#12066](https://github.com/microsoft/vscode/issues/12066))
- feat: support DAP `hitBreakpointIds` ([#994](https://github.com/microsoft/vscode-js-debug/issues/994))
- feat: add Edge inspector integration
- feat: allow limited adjustment of launch config options during restart ([vscode#118196](https://github.com/microsoft/vscode/issues/118196))
- fix: make sure servers are listening before returning
- fix: don't send infinite telemetry requests for React Native ([#981](https://github.com/microsoft/vscode-js-debug/issues/981))
- fix: skipFiles working inconsistently in `attach` mode ([vscode#118282](https://github.com/microsoft/vscode/issues/118282))
- fix: contribute js-debug to html ([vscode#123106](https://github.com/microsoft/vscode/issues/123106))
- chore: log errors activating auto attach
- fix: intermittent debug failures with browsers, especially Electron ([vscode#123420](https://github.com/microsoft/vscode/issues/123420)))
- fix: add additional languages for browser debugging ([vscode#123484](https://github.com/microsoft/vscode/issues/123484))
- fix: worker processes breaking sessions when attaching multiple times ([vscode#124045](https://github.com/microsoft/vscode/issues/124045))
- fix: wrong name of autogenerated edge debug config
- fix: add warning for outdated or buggy Node.js versions ([#1017](https://github.com/microsoft/vscode-js-debug/issues/1017))
- refactor: include a mandatory path in the CDP proxy ([#987](https://github.com/microsoft/vscode-js-debug/issues/987))
- chore: adopt new terminal profile contribution point ([vscode#120369](https://github.com/microsoft/vscode/issues/120369))

## v1.56 (April 2021)

### v1.56.2 - 2021-04-39

- fix: string previews not working in RN Windows

### v1.56.1 - 2021-04-23

- feat: show private properties in the inspector ([#892](https://github.com/microsoft/vscode-js-debug/issues/892))
- fix: sources not working in RN Windows ([vscode#121136](https://github.com/microsoft/vscode/issues/121136))
- fix: improve suggest tool behavior ([#970](https://github.com/microsoft/vscode-js-debug/issues/970))
- fix: re-apply breakpoints if pages crash

### v1.56.0 - 2021-04-07

- feat: 'intelligently' suggest using diagnostic tool for breakpoint issues ([vscode#57590](https://github.com/microsoft/vscode/issues/57590))
- feat: add cdp sharing for extensions to interact with debugging, see [docs](./CDP_SHARE.md) ([#892](https://github.com/microsoft/vscode-js-debug/issues/893))
- fix: runtimeVersion overwriting default PATH ([vscode#120140](https://github.com/microsoft/vscode/issues/120140))
- fix: skipFiles not skipping ranges in sourcemapped scripts ([vscode#118282](https://github.com/microsoft/vscode/issues/118282))
- chore: update wording on debug terminal label to match new profiles
- fix: 'node version is outdated' incorrectly showing with auto attach ([#957](https://github.com/microsoft/vscode-js-debug/issues/957))
- fix: programs not terminating in 'run without debugging' with break on exception ([vscode#119340](https://github.com/microsoft/vscode/issues/119340))
- fix: browser debugging when using a WSL remote ([vscode#120227](https://github.com/microsoft/vscode/issues/120227))

## v1.55 (March 2021)

### v1.55.1 - 2021-03-24

- fix: sessions hanging if exception is thrown immediately before or during shutdown
- fix: track DAP servers in ports manager as well ([#942 comment](https://github.com/microsoft/vscode-js-debug/issues/942#event-4501887036))

### v1.55.0 - 2021-03-22

- feat: implement 'start debugging and stop on entry' command/keybinding ([vscode#49855](https://github.com/microsoft/vscode/issues/49855))
- feat: improve handling of symbolic links ([#776](https://github.com/microsoft/vscode-js-debug/issues/776))
- feat: add forwarded port attributes ([#942](https://github.com/microsoft/vscode-js-debug/issues/942))
- fix: pretty print not working when evaling sources ([#929](https://github.com/microsoft/vscode-js-debug/issues/929))
- fix: browser debugging in remote not working on some Linux systems ([#908](https://github.com/microsoft/vscode-js-debug/issues/908))
- fix: edge not launching if VS Code is run in admin mode on windows ([vscode#117005](https://github.com/microsoft/vscode/issues/117005))
- fix: exception breakpoint toggle getting stuck ([919](https://github.com/microsoft/vscode-js-debug/issues/919))
- fix: spooky race that could incorrectly break when entering hot-transpiled code

## v1.54 (February 2021)

### v1.54.4 - 2021-03-04

- fix: worker_thread debugging node working on Node >14.5.0 ([933](https://github.com/microsoft/vscode-js-debug/issues/933))

### v1.54.3 - 2021-02-24

- fix: auto attach failing when entering node repl

### v1.54.2 - 2021-02-23

- fix: auto attach only to workspace scripts by default ([#856](https://github.com/microsoft/vscode-js-debug/issues/856))
- fix: do not show restart frame action on async stacktraces ([vscode#116345](https://github.com/microsoft/vscode/issues/116345))
- fix: do not attach to node-gyp fixing install failures ([vscode#117312](https://github.com/microsoft/vscode/issues/117312))
- fix: sessions being mixed up or not initializing when attaching concurrently ([vscode#115996](https://github.com/microsoft/vscode/issues/115996))

### v1.54.1 - 2021-02-04

- fix: wrong command used in create debug terminal command

### v1.54.0 - 2021-02-08

- fix: allow copying values from watch expressions ([vscode#115049](https://github.com/microsoft/vscode/issues/115049))
- fix: reuse debug terminals when running npm scripts, when possible
- refactor: move script lens functionality into built-in npm extension

## v1.53 (January 2021)

### v1.53.0 - 2021-01-25

- feat: allow debugging node worker_threads
- feat: allow pausing on conditional exceptions ([vscode#104453](https://github.com/microsoft/vscode/issues/104453))
- feat: make the line on log messages take into account skipFiles ([#882](https://github.com/microsoft/vscode-js-debug/issues/882))
- feat: allow specifying request options used to request sourcemaps and content ([#904](https://github.com/microsoft/vscode-js-debug/issues/904))
- fix: persist state in the diagnostic tool ([#879](https://github.com/microsoft/vscode-js-debug/issues/879))
- fix: allow outdated node dialog to be bypassed ([vscode#111642](https://github.com/microsoft/vscode/issues/111642))
- fix: syntax errors in chrome not showing locations ([#867](https://github.com/microsoft/vscode-js-debug/issues/867))
- fix: handle certain types of webpack source maps in attachments ([#854](https://github.com/microsoft/vscode-js-debug/issues/854))
- fix: attachment issue on Node 15 ([#895](https://github.com/microsoft/vscode-js-debug/issues/895))
- fix: default node cwd to the localRoot if set ([#894](https://github.com/microsoft/vscode-js-debug/issues/894))
- fix: fix: better handle html served as index and without extensions ([#883](https://github.com/microsoft/vscode-js-debug/issues/883), [#884](https://github.com/microsoft/vscode-js-debug/issues/884))
- docs: remove preview terminology from js-debug ([#894](https://github.com/microsoft/vscode-js-debug/issues/894))
- fix: debugger statements being missed if directly stepped on the first executable line of a new script early in execution
- fix: source map warning on node 15 ([#903](https://github.com/microsoft/vscode-js-debug/issues/903))

## v1.52 (November/December 2020)

### v1.52.2 - 2020-12-07

- fix: issue preventing breakpoint predictor from running in ext host ([vscode#112052](https://github.com/microsoft/vscode/issues/112052))

### v1.52.1 - 2020-12-01

- fix: processes not being killed on posix ([#864](https://github.com/microsoft/vscode-js-debug/issues/864))

### v1.52.0 - 2020-11-30

- feat: allow debugging node internals ([#823](https://github.com/microsoft/vscode-js-debug/issues/823))
- feat: show diagnostic tool in a webview and integrate with vscode theme ([vscode#109526](https://github.com/microsoft/vscode/issues/109526), [vscode#109529](https://github.com/microsoft/vscode/issues/109529), [vscode#109531](https://github.com/microsoft/vscode/issues/109531))
- feat: allow specifying defaults runtimeExecutables ([#836](https://github.com/microsoft/vscode-js-debug/issues/836))
- feat: support vscode webview resource uri sourcemaps ([#820](https://github.com/microsoft/vscode-js-debug/pull/820))
- feat: allow configuring the debugger killBehavior ([#630](https://github.com/microsoft/vscode-js-debug/issues/630))
- fix: support chrome dev and beta builds ([ref](https://github.com/OmniSharp/omnisharp-vscode/issues/4108))
- fix: race causing potentially corrupted log files ([#825](https://github.com/microsoft/vscode-js-debug/issues/825))
- fix: extension host debugging pausing in internals ([vscode#105047](https://github.com/microsoft/vscode/issues/105047))
- fix: make urls ending in `/*` also match the base path ([#834](https://github.com/microsoft/vscode-js-debug/issues/834))
- fix: ignore hash portion of url when determining matches ([#840](https://github.com/microsoft/vscode-js-debug/issues/840))
- fix: automatically add a \* suffix to sourceMapPathOverrides that lack one ([#841](https://github.com/microsoft/vscode-js-debug/issues/841))
- fix: don't show `Debug: Open Link` command in web where it doesn't work
- fix: handle exceptions thrown dealing with sourcemaps in prediction ([#845](https://github.com/microsoft/vscode-js-debug/issues/845))
- fix: don't show quick pick when there is only a single npm script ([#851](https://github.com/microsoft/vscode-js-debug/issues/851))
- fix: don't narrow outfiles on any remoteRoot ([#854](https://github.com/microsoft/vscode-js-debug/issues/854))
- fix: more thoroughly clean VS Code-specific environment variables from launch ([#64897](https://github.com/microsoft/vscode/issues/64897), [#38428](https://github.com/microsoft/vscode/issues/38428))
- fix: node internals not skipping on Node 15 ([#862](https://github.com/microsoft/vscode-js-debug/issues/862))
- fix: don't scan outfiles when sourceMaps is false ([#866](https://github.com/microsoft/vscode-js-debug/issues/866))
- fix: skipfiles not working for paths in dotfiles/folders ([vscode#111301](https://github.com/microsoft/vscode/issues/111301))

## v1.51 (October 2020)

### v1.51.0 - 2020-10-26

- feat: add a diagnostic tool under the `Create Diagnostic Information` command ([#260](https://github.com/microsoft/vscode-js-debug/issues/260))
- feat: add an advanced `perScriptSourcemaps` option, when loading individual unbundled scripts
- feat: suffix rather than prefix setter/getters ([vscode#108036](https://github.com/microsoft/vscode/issues/108036))
- fix: include the response body in sourcemap http error info
- fix: extensions being able to activate before the debugger attaches ([vscode#108141](https://github.com/microsoft/vscode/pull/108141))
- fix: debugger failing to connect on Node 14 on Windows 7 ([#791](https://github.com/microsoft/vscode-js-debug/issues/791))
- fix: inherit the system's NODE_OPTIONS if set ([#790](https://github.com/microsoft/vscode-js-debug/issues/790))
- fix: use `*` as a urlFilter by default only for launching (not attaching) ([ref](https://github.com/microsoft/vscode-chrome-debug/issues/719))
- fix: exclude `nvm`-installed binaries from auto attach ([#794](https://github.com/microsoft/vscode-js-debug/issues/794))
- fix: smart auto attaching briefly debugging a process when using `code` from the CLI ([#783](https://github.com/microsoft/vscode-js-debug/issues/783))
- fix: realtime performance not being shown when a webworker is selected ([ref](https://github.com/microsoft/vscode-js-profile-visualizer/issues/23))
- fix: breakpoints sometimes not being rebound after navigating away from and back to a page ([#807](https://github.com/microsoft/vscode-js-debug/issues/807))
- fix: breakpoints not being bound correctly on Blazor apps ([#796](https://github.com/microsoft/vscode-js-debug/issues/796))
- fix: remote source maps don't resolve correctly with an absolute sourceroot shorter than the local path ([vscode#108418](https://github.com/microsoft/vscode/issues/108418))
- fix: terminal links not setting the first workspace folder ([#701](https://github.com/microsoft/vscode-js-debug/issues/701))
- fix: send ctrl+c to kill nodemon running in debug terminal ([vscode#108289](https://github.com/microsoft/vscode/issues/108289))
- fix: increase auto attach timeout ([#806](https://github.com/microsoft/vscode-js-debug/issues/806))
- fix: stepping into function on the first line of a file with a breakpoint ([vscode#107859](https://github.com/microsoft/vscode/issues/107859))
- fix: webpage opening twice when using `serverReadyAction` with `console: integratedTerminal` ([#814](https://github.com/microsoft/vscode-js-debug/issues/814))
- refactor: improve performance when loading very many sourcemaps for pages that don't need authentication
- refactor: remove runtime dependency on TypeScript ([vscode#107680](https://github.com/microsoft/vscode/issues/107680))

## 1.50.2 - 2020-10-02

Start of changelog records
