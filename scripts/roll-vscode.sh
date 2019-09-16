#/bin/sh
pushd src/typings
npx vscode-dts dev
npx vscode-dts master
popd
