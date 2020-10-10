# Changelog

This changelog records changes to stable releases since 1.50.2. "TBA" changes here may be available in the [nightly release](https://github.com/microsoft/vscode-js-debug/#nightly-extension) before they're in stable.

## TBA

- feat: add a diagnostic tool under the `Create Diagnostic Information` command ([#260](https://github.com/microsoft/vscode-js-debug/issues/260))
- fix: include the response body in sourcemap http error info
- fix: extensions being able to activate before the debugger attaches ([ref](https://github.com/microsoft/vscode/pull/108141))
- fix: debugger failing to connect on Node 14 on Windows 7 ([#791](https://github.com/microsoft/vscode-js-debug/issues/791))
- fix: inherit the system's NODE_OPTIONS if set ([#790](https://github.com/microsoft/vscode-js-debug/issues/790))
- fix: use `*` as a urlFilter by default only for launching (not attaching) ([ref](https://github.com/microsoft/vscode-chrome-debug/issues/719))
- fix: exclude `nvm`-installed binaries from auto attach ([#794](https://github.com/microsoft/vscode-js-debug/issues/794))
- fix: smart auto attaching briefly debugging a process when using `code` from the CLI ([#783](https://github.com/microsoft/vscode-js-debug/issues/783))
- fix: realtime performance not being shown when a webworker is selected ([ref](https://github.com/microsoft/vscode-js-profile-visualizer/issues/23))
- refactor: remove runtime dependency on TypeScript ([ref](https://github.com/microsoft/vscode/issues/107680))

## 1.50.2 - 2020-10-02

Start of changelog records
