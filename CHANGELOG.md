# Changelog

This changelog records changes to stable releases since 1.50.2. "TBA" changes here may be available in the [nightly release](https://github.com/microsoft/vscode-js-debug/#nightly-extension) before they're in stable. Note that the minor version (`v1.X.0`) corresponds to the VS Code version js-debug is shipped in, but the patch version (`v1.50.X`) is not meaningful.

## TBA

- fix: auto attach only to workspace scripts by default ([#856](https://github.com/microsoft/vscode-js-debug/issues/856))
- fix: do not show restart frame action on async stacktraces ([ref](https://github.com/microsoft/vscode/issues/116345))

## v1.54.1 - 2021-02-04

- fix: wrong command used in create debug terminal command

## v1.54.0 - 2021-02-08

- fix: allow copying values from watch expressions ([ref](https://github.com/microsoft/vscode/issues/115049))
- fix: reuse debug terminals when running npm scripts, when possible
- refactor: move script lens functionality into built-in npm extension

## v1.53.0 - 2021-01-25

- feat: allow debugging node worker_threads
- feat: allow pausing on conditional exceptions ([ref](https://github.com/microsoft/vscode/issues/104453))
- feat: make the line on log messages take into account skipFiles ([#882](https://github.com/microsoft/vscode-js-debug/issues/882))
- feat: allow specifying request options used to request sourcemaps and content ([#904](https://github.com/microsoft/vscode-js-debug/issues/904))
- fix: persist state in the diagnostic tool ([#879](https://github.com/microsoft/vscode-js-debug/issues/879))
- fix: allow outdated node dialog to be bypassed ([ref](https://github.com/microsoft/vscode/issues/111642))
- fix: syntax errors in chrome not showing locations ([#867](https://github.com/microsoft/vscode-js-debug/issues/867))
- fix: handle certain types of webpack source maps in attachments ([#854](https://github.com/microsoft/vscode-js-debug/issues/854))
- fix: attachment issue on Node 15 ([#895](https://github.com/microsoft/vscode-js-debug/issues/895))
- fix: default node cwd to the localRoot if set ([#894](https://github.com/microsoft/vscode-js-debug/issues/894))
- fix: fix: better handle html served as index and without extensions ([#883](https://github.com/microsoft/vscode-js-debug/issues/883), [#884](https://github.com/microsoft/vscode-js-debug/issues/884))
- docs: remove preview terminology from js-debug ([#894](https://github.com/microsoft/vscode-js-debug/issues/894))
- fix: debugger statements being missed if directly stepped on the first executable line of a new script early in execution
- fix: source map warning on node 15 ([#903](https://github.com/microsoft/vscode-js-debug/issues/903))

## v1.52.2 - 2020-12-07

- fix: issue preventing breakpoint predictor from running in ext host ([ref](https://github.com/microsoft/vscode/issues/112052))

## v1.52.1 - 2020-12-01

- fix: processes not being killed on posix ([#864](https://github.com/microsoft/vscode-js-debug/issues/864))

## v1.52.0 - 2020-11-30

- feat: allow debugging node internals ([#823](https://github.com/microsoft/vscode-js-debug/issues/823))
- feat: show diagnostic tool in a webview and integrate with vscode theme ([ref](https://github.com/microsoft/vscode/issues/109526), [ref](https://github.com/microsoft/vscode/issues/109529), [ref](https://github.com/microsoft/vscode/issues/109531))
- feat: allow specifying defaults runtimeExecutables ([#836](https://github.com/microsoft/vscode-js-debug/issues/836))
- feat: support vscode webview resource uri sourcemaps ([#820](https://github.com/microsoft/vscode-js-debug/pull/820))
- feat: allow configuring the debugger killBehavior ([#630](https://github.com/microsoft/vscode-js-debug/issues/630))
- fix: support chrome dev and beta builds ([ref](https://github.com/OmniSharp/omnisharp-vscode/issues/4108))
- fix: race causing potentially corrupted log files ([#825](https://github.com/microsoft/vscode-js-debug/issues/825))
- fix: extension host debugging pausing in internals ([ref](https://github.com/microsoft/vscode/issues/105047))
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
- fix: skipfiles not working for paths in dotfiles/folders ([ref](https://github.com/microsoft/vscode/issues/111301))

## v1.51.0 - 2020-10-26

- feat: add a diagnostic tool under the `Create Diagnostic Information` command ([#260](https://github.com/microsoft/vscode-js-debug/issues/260))
- feat: add an advanced `perScriptSourcemaps` option, when loading individual unbundled scripts
- feat: suffix rather than prefix setter/getters ([ref](https://github.com/microsoft/vscode/issues/108036))
- fix: include the response body in sourcemap http error info
- fix: extensions being able to activate before the debugger attaches ([ref](https://github.com/microsoft/vscode/pull/108141))
- fix: debugger failing to connect on Node 14 on Windows 7 ([#791](https://github.com/microsoft/vscode-js-debug/issues/791))
- fix: inherit the system's NODE_OPTIONS if set ([#790](https://github.com/microsoft/vscode-js-debug/issues/790))
- fix: use `*` as a urlFilter by default only for launching (not attaching) ([ref](https://github.com/microsoft/vscode-chrome-debug/issues/719))
- fix: exclude `nvm`-installed binaries from auto attach ([#794](https://github.com/microsoft/vscode-js-debug/issues/794))
- fix: smart auto attaching briefly debugging a process when using `code` from the CLI ([#783](https://github.com/microsoft/vscode-js-debug/issues/783))
- fix: realtime performance not being shown when a webworker is selected ([ref](https://github.com/microsoft/vscode-js-profile-visualizer/issues/23))
- fix: breakpoints sometimes not being rebound after navigating away from and back to a page ([#807](https://github.com/microsoft/vscode-js-debug/issues/807))
- fix: breakpoints not being bound correctly on Blazor apps ([#796](https://github.com/microsoft/vscode-js-debug/issues/796))
- fix: remote source maps don't resolve correctly with an absolute sourceroot shorter than the local path ([ref](https://github.com/microsoft/vscode/issues/108418))
- fix: terminal links not setting the first workspace folder ([#701](https://github.com/microsoft/vscode-js-debug/issues/701))
- fix: send ctrl+c to kill nodemon running in debug terminal ([ref](https://github.com/microsoft/vscode/issues/108289))
- fix: increase auto attach timeout ([#806](https://github.com/microsoft/vscode-js-debug/issues/806))
- fix: stepping into function on the first line of a file with a breakpoint ([ref](https://github.com/microsoft/vscode/issues/107859))
- fix: webpage opening twice when using `serverReadyAction` with `console: integratedTerminal` ([#814](https://github.com/microsoft/vscode-js-debug/issues/814))
- refactor: improve performance when loading very many sourcemaps for pages that don't need authentication
- refactor: remove runtime dependency on TypeScript ([ref](https://github.com/microsoft/vscode/issues/107680))

## 1.50.2 - 2020-10-02

Start of changelog records
