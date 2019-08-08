#/bin/sh
rm -rf build
echo "exports.vscode = null;" >> node_modules/node-libs-browser/index.js
echo "exports.inspector = null;" >> node_modules/node-libs-browser/index.js
if [ ! -f src/extension.ts ]; then
    echo "src/extension.ts not found!"
    exit 1
fi
if [ ! -f src/targets/node/bootloader.ts ]; then
    echo "src/targets/node/bootloader.ts not found!"
    exit 1
fi
if [ ! -f src/targets/node/watchdog.ts ]; then
    echo "src/targets/node/watchdog.ts not found!"
    exit 1
fi
./node_modules/.bin/parcel build src/extension.ts src/targets/node/bootloader.ts src/targets/node/watchdog.ts --target node -d out/ --no-source-maps --bundle-node-modules
cp out/targets/node/watchdog.js out/
cp out/targets/node/bootloader.js out/
