#/bin/sh
rm -rf build
echo "exports.vscode = null;" >> node_modules/node-libs-browser/index.js
echo "exports.inspector = null;" >> node_modules/node-libs-browser/index.js
./node_modules/.bin/parcel build src/extension.ts src/node/bootloader.ts src/node/watchdog.ts --target node -d out/ --no-source-maps --bundle-node-modules
cp out/node/watchdog.js out/
cp out/node/bootloader.js out/
