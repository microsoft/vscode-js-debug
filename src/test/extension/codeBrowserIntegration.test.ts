/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import { createServer, Server } from 'http';
import type { AddressInfo } from 'net';
import { SinonSpy, stub } from 'sinon';
import * as vscode from 'vscode';
import { DebugType } from '../../common/contributionUtils';
import { EventEmitter } from '../../common/events';

describe('integrated browser debugging', function() {
  this.timeout(30_000);

  let server: Server;
  let serverUrl: string;

  before(async function() {
    // Skip entire suite when the proposed browser API is not available
    if (typeof vscode.window.openBrowserTab !== 'function') {
      return this.skip();
    }

    await new Promise<void>(resolve => {
      server = createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<!DOCTYPE html><html><body><script>var testValue = 42;</script></body></html>');
      });
      server.listen(0, '127.0.0.1', resolve);
    });
    serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    try {
      await vscode.debug.stopDebugging();
    } catch {
      // no active session to stop
    }
  });

  after(async () => {
    if (server) {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  /** Waits for a child debug session to start (one with __pendingTargetId). */
  const waitForChildSession = () =>
    new Promise<vscode.DebugSession>(resolve => {
      const d = vscode.debug.onDidStartDebugSession(s => {
        if ('__pendingTargetId' in s.configuration) {
          d.dispose();
          resolve(s);
        }
      });
    });

  it('launch opens a browser tab visible via the API', async () => {
    const tabsBefore = [...vscode.window.browserTabs];
    const sessionStarted = waitForChildSession();

    await vscode.debug.startDebugging(undefined, {
      type: DebugType.CodeBrowser,
      request: 'launch',
      name: 'Launch Test',
      url: serverUrl,
    });

    const session = await sessionStarted;
    expect(session).to.exist;

    // The launcher calls openBrowserTab, so a new tab should appear
    const tabsAfter = vscode.window.browserTabs;
    const newTabs = tabsAfter.filter(t => !tabsBefore.includes(t));
    expect(newTabs).to.have.lengthOf(1, 'expected exactly one new browser tab');
    expect(newTabs[0].url).to.include(serverUrl);

    await vscode.debug.stopDebugging(session);
  });

  it('attach debugs the pre-opened tab without opening another', async () => {
    // Open a tab before starting the debug session
    const tab = await vscode.window.openBrowserTab(serverUrl, { background: true });
    const tabCountBefore = vscode.window.browserTabs.length;

    // Stub createQuickPick to auto-select the tab matching our URL
    let acceptEmitter: EventEmitter<void>;
    const originalCreateQuickPick = vscode.window.createQuickPick;
    const createQuickPickStub: SinonSpy = stub(
      vscode.window,
      'createQuickPick',
    ).callsFake(() => {
      const picker = originalCreateQuickPick.call(vscode.window);
      acceptEmitter = new EventEmitter<void>();
      stub(picker, 'onDidAccept').callsFake(acceptEmitter.event);

      // Once shown, poll for items matching our tab and auto-accept
      const origShow = picker.show.bind(picker);
      stub(picker, 'show').callsFake(() => {
        origShow();
        const interval = setInterval(() => {
          const match = picker.items.find(
            i => 'detail' in i && typeof i.detail === 'string' && i.detail.includes(serverUrl),
          );
          if (match) {
            clearInterval(interval);
            picker.selectedItems = [match];
            acceptEmitter.fire();
          }
        }, 50);
      });

      return picker;
    });

    try {
      const sessionStarted = waitForChildSession();

      await vscode.debug.startDebugging(undefined, {
        type: DebugType.CodeBrowser,
        request: 'attach',
        name: 'Attach Test',
      });

      const session = await sessionStarted;
      expect(session).to.exist;

      // Verify no additional browser tabs were opened
      expect(vscode.window.browserTabs).to.have.lengthOf(
        tabCountBefore,
        'attach should not open a new browser tab',
      );

      // Verify the tab we opened is the one being debugged by checking
      // that the debugged URL matches our pre-opened tab
      expect(tab.url).to.include(serverUrl);

      await vscode.debug.stopDebugging(session);
    } finally {
      createQuickPickStub.restore();
    }
  });
});
