/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { itIntegrates } from '../testIntegrationUtils';
import { testFixturesDir } from '../test';
import { expect } from 'chai';
import mkdirp from 'mkdirp';
import { readdirSync } from 'fs';
import WebSocket from 'ws';
import { constructInspectorWSUri } from '../../targets/browser/constructInspectorWSUri';

describe('browser launch', () => {
  itIntegrates('environment variables', async ({ r }) => {
    if (process.platform === 'win32') {
      return; // Chrome on windows doesn't set the TZ correctly
    }

    const p = await r.launchUrlAndLoad('index.html', {
      env: {
        TZ: 'GMT',
      },
    });

    await p.logger.evaluateAndLog(`new Date().getTimezoneOffset()`);
    r.assertLog();
  });

  itIntegrates('runtime args', async ({ r }) => {
    const p = await r.launchUrlAndLoad('index.html', {
      runtimeArgs: ['--window-size=678,456'],
    });

    await p.logger.evaluateAndLog(`[window.outerWidth, window.outerHeight]`);
    r.assertLog();
  });

  itIntegrates.skip('user data dir', async ({ r }) => {
    mkdirp.sync(testFixturesDir);
    expect(readdirSync(testFixturesDir)).to.be.empty;

    await r.launchUrlAndLoad('index.html', {
      userDataDir: testFixturesDir,
    });

    expect(readdirSync(testFixturesDir)).to.not.be.empty;
  });

  itIntegrates('connects to rewritten websocket when using inspectUri parameter', async ({ r }) => {
    const pagePort = 5935;
    const wsServer = new WebSocket.Server({ port: pagePort, path: '/_framework/debug/ws-proxy' });

    try {
      const receivedMessage = new Promise(resolve => {
        wsServer.on('connection', function connection(ws) {
          ws.on('message', function incoming(message) {
            ws.send(
              '{"id":1,"method":"Target.attachToBrowserTarget","error": { "message": "Fake websocket" }}',
            );
            resolve(message.toString()); // We resolve with the contents of the first message we receive
          });
        });
      });

      r.launchUrl(`index.html`, {
        inspectUri: `{wsProtocol}://{url.hostname}:${pagePort}/_framework/debug/ws-proxy?browser={browserInspectUri}`,
      }); // We don't care about the launch result, as long as we connect to the WebSocket

      expect(await receivedMessage).to.be.eq(
        '{"id":1,"method":"Target.attachToBrowserTarget","params":{}}',
      ); // Verify we got the first message on the WebSocket
    } finally {
      wsServer.close();
    }
  });
});

describe('constructInspectorWSUri', () => {
  const inspectUri =
    '{wsProtocol}://{url.hostname}:{url.port}/_framework/debug/ws-proxy?browser={browserInspectUri}';

  const appHttpUrl = 'http://localhost:5001/';
  const browserWsInspectUri =
    'ws://127.0.0.1:36775/devtools/browser/a292f96c-7332-4ce8-82a9-7411f3bd280a';
  const encodedBrowserWsInspectUri = encodeURIComponent(browserWsInspectUri);

  const appHttpsUrl = 'https://localhost:5001/';
  it('interpolates arguments to construct inspectUri', () => {
    expect(constructInspectorWSUri(inspectUri, appHttpUrl, browserWsInspectUri)).to.be.eq(
      `ws://localhost:5001/_framework/debug/ws-proxy?browser=${encodedBrowserWsInspectUri}`,
    );
    expect(constructInspectorWSUri(inspectUri, appHttpsUrl, browserWsInspectUri)).to.be.eq(
      `wss://localhost:5001/_framework/debug/ws-proxy?browser=${encodedBrowserWsInspectUri}`,
    );
  });

  it('does not do anything with arguments that does not exist', () => {
    expect(
      constructInspectorWSUri(
        inspectUri + '&{iDoNotExist}{meEither}',
        appHttpUrl,
        browserWsInspectUri,
      ),
    ).to.be.eq(
      `ws://localhost:5001/_framework/debug/ws-proxy?browser=${encodedBrowserWsInspectUri}&{iDoNotExist}{meEither}`,
    );
  });

  it('fails with an useful error for invalid urls', () => {
    expect(() => constructInspectorWSUri(inspectUri, '.not_an_url', browserWsInspectUri)).to.throw(
      'Invalid URL: .not_an_url',
    );
    expect(() => constructInspectorWSUri(inspectUri, null, browserWsInspectUri)).to.throw(
      `A valid url wasn't supplied: <null>`,
    );
    expect(() => constructInspectorWSUri(inspectUri, undefined, browserWsInspectUri)).to.throw(
      `A valid url wasn't supplied: <undefined>`,
    );
    expect(() => constructInspectorWSUri(inspectUri, '', browserWsInspectUri)).to.throw(
      `A valid url wasn't supplied: <>`,
    );
  });

  const noUrlInspectUri =
    'ws://localhost:1234/_framework/debug/ws-proxy?browser={browserInspectUri}';
  it('does not fail for an invalid url if it isnt used', () => {
    expect(constructInspectorWSUri(noUrlInspectUri, '.not_an_url', browserWsInspectUri)).to.be.eq(
      `ws://localhost:1234/_framework/debug/ws-proxy?browser=${encodedBrowserWsInspectUri}`,
    );
    expect(constructInspectorWSUri(noUrlInspectUri, undefined, browserWsInspectUri)).to.be.eq(
      `ws://localhost:1234/_framework/debug/ws-proxy?browser=${encodedBrowserWsInspectUri}`,
    );
  });
});
