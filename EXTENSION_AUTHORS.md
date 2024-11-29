# Extensibility

js-debug has a few ways other extensions can 'plug into' js-debug and provide additional extensibility.

## Extension API

js-debug provides an extension API you can use to do certain things. Please refer to [the typings](https://github.com/microsoft/vscode-js-debug/blob/main/src/typings/vscode-js-debug.d.ts) for capabilities.

To use this, you would:

1. Add a step in your build process to download the typings from https://github.com/microsoft/vscode-js-debug/blob/main/src/typings/vscode-js-debug.d.ts to somewhere in your source tree.
2. Access the API like so:

   ```js
   const jsDebugExt = vscode.extensions.getExtension('ms-vscode.js-debug-nightly') || vscode.extensions.getExtension('ms-vscode.js-debug');
   await jsDebugExt.activate()
   const jsDebug: import('@vscode/js-debug').IExports = jsDebugExt.exports;
   ```

## CDP Sharing Mechanism

This file documents the CDP sharing mechanism in js-debug. It can be useful for advanced extensions and plugins. The original feature request can be found in [#892](https://github.com/microsoft/vscode-js-debug/issues/893).

### Requesting a CDP Connection

js-debug can be asked to share its CDP connection by running the `extension.js-debug.requestCDPProxy` command with the debug session ID you wish to connect to. js-debug will respond with an object containing a WebSocket server address in the form `{ host: string, port: string }`. You can see a sample extension that requests this information [here](https://github.com/connor4312/cdp-proxy-requestor/blob/main/extension.js).

Note that the server will always be running in the workspace. If you have a UI extension, you may need to forward the port. We also recommend using `permessage-deflate` on the WebSocket for better performance over remote connections.

### Protocol

The protocol spoken over the WebSocket is, unsurprisingly, CDP. Over the websocket, the `sessionId` will never be used and will always be ignored. This is because a single js-debug debug session corresponds to exactly one CDP session. Other targets--like iframes, workers, and subprocesses--are represented as separate debug sessions which you can connect to separately.

Additionally, by default, you will not receive any CDP events on the socket. This is because the underlying CDP connection is shared between js-debug and consumers of the mechanism, and we want to avoid doing extra work to send events you don't care about. To listen to events, you can use the JsDebug domain:

#### JsDebug domain

js-debug exposes a `JsDebug` CDP domain for meta-communication. For example, you would call the method `JsDebug.subscribe` to subscribe to evetns.

- The TypeScript definition of the available methods can be found [here](https://github.com/microsoft/vscode-js-debug/blob/main/src/adapter/cdpProxy.ts#L22).
- The PDL definition can be found [here](https://github.com/microsoft/vscode-js-debug/blob/main/src/adapter/cdpProxy.pdl).

These definitions will be published in an npm package soon.
