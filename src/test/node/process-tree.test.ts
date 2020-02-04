/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import { stub } from 'sinon';
import { PosixProcessTree } from '../../ui/processTree/posixProcessTree';
import { EventEmitter } from 'events';
import { IProcess, IProcessTree, processTree } from '../../ui/processTree/processTree';
import { ReadableStreamBuffer } from 'stream-buffers';
import { DarwinProcessTree } from '../../ui/processTree/darwinProcessTree';
import { WindowsProcessTree } from '../../ui/processTree/windowsProcessTree';

const fakeChildProcess = (stdoutData: string) => {
  const ee: any = new EventEmitter();
  ee.stderr = new ReadableStreamBuffer();
  ee.stderr.stop();
  ee.stdout = new ReadableStreamBuffer({ frequency: 2, chunkSize: 32 });
  ee.stdout.put(stdoutData);
  ee.stdout.stop();
  ee.stdout.once('end', () => setTimeout(() => ee.emit('close', 0), 1));

  return ee;
};

const assertParses = async (tree: IProcessTree, input: string, expected: IProcess[]) => {
  const stubbed = stub(tree, 'createProcess' as any).returns(fakeChildProcess(input));
  try {
    const result = await tree.lookup<IProcess[]>((entry, acc) => [...acc, entry], []);
    expect(result).to.deep.equal(expected);
  } finally {
    stubbed.restore();
  }
};

// These tests are a handful of samples taken by manually running the process
// tree on given platforms.
describe('process tree', () => {
  it('gives some output for the current platform', async () => {
    // sanity check
    const data = await processTree.lookup<IProcess[]>((entry, acc) => [...acc, entry], []);
    expect(data.length).to.be.greaterThan(0);
    expect(data[0].pid).to.be.a('number');
    expect(data[0].ppid).to.be.a('number');
    expect(data[0].command).to.match(/./); // not empty string
  });

  if (process.platform !== 'win32') {
    it('gets the working directory', async () => {
      const currentWd = await processTree.getWorkingDirectory(process.pid);
      expect(currentWd).to.equal(process.cwd());
    });
  }

  it('works for darwin', async () => {
    await assertParses(
      new DarwinProcessTree(),
      '  PID  PPID BINARY           COMMAND\n  380     1 /usr/sbin/cfpref /usr/sbin/cfprefsd agent\n  381     1 /usr/libexec/Use /usr/libexec/UserEventAgent (Aqua)\n  383     1 /usr/sbin/distno /usr/sbin/distnoted agent\n  384     1 /usr/libexec/USB /usr/libexec/USBAgent\n  387     1 /System/Library/ /System/Library/Frameworks/CoreTelephony.framework/Support/CommCenter -L\n  389     1 /usr/libexec/lsd /usr/libexec/lsd\n  390     1 /usr/libexec/tru /usr/libexec/trustd --agent\n  391     1 /usr/libexec/sec /usr/libexec/secd\n  392     2 /System/Library/ /System/Library/PrivateFrameworks/CloudKitDaemon.framework/Support/cloudd',
      [
        { pid: 380, ppid: 1, command: 'usr/sbin/cfpref', args: '/usr/sbin/cfprefsd agent' },
        {
          pid: 381,
          ppid: 1,
          command: 'usr/libexec/Use',
          args: '/usr/libexec/UserEventAgent (Aqua)',
        },
        { pid: 383, ppid: 1, command: 'usr/sbin/distno', args: '/usr/sbin/distnoted agent' },
        { pid: 384, ppid: 1, command: 'usr/libexec/USB', args: '/usr/libexec/USBAgent' },
        {
          pid: 387,
          ppid: 1,
          command: 'System/Library/',
          args: '/System/Library/Frameworks/CoreTelephony.framework/Support/CommCenter -L',
        },
        { pid: 389, ppid: 1, command: 'usr/libexec/lsd', args: '/usr/libexec/lsd' },
        { pid: 390, ppid: 1, command: 'usr/libexec/tru', args: '/usr/libexec/trustd --agent' },
        { pid: 391, ppid: 1, command: 'usr/libexec/sec', args: '/usr/libexec/secd' },
        {
          pid: 392,
          ppid: 2,
          command: 'System/Library/',
          args: '/System/Library/PrivateFrameworks/CloudKitDaemon.framework/Support/cloudd',
        },
      ],
    );
  });

  it('works for posix', async () => {
    await assertParses(
      new PosixProcessTree(),
      '   PID   PPID BINARY          COMMAND\n   351      1 systemd         /lib/systemd/systemd --user\n   352    351 (sd-pam)        (sd-pam)\n   540      1 sh              sh /home/connor/.vscode-server-insiders/bin/bbf00d8ea6aa7e825ca3393364d746fe401d3299/server.sh --host=127.0.0.1 --enable-remote-auto-shutdown --port=0\n   548    540 node            /home/connor/.vscode-server-insiders/bin/bbf00d8ea6aa7e825ca3393364d746fe401d3299/node /home/connor/.vscode-server-insiders/bin/bbf00d8ea6aa7e825ca3393364d746fe401d3299/out/vs/server/main.js --host=127.0.0.1 --enable-remote-auto-shutdown --port=0\n  6557   6434 sshd            sshd: connor@notty\n  6558   6557 bash            bash\n  7281   7199 sshd            sshd: connor@pts/0\n  7282   7281 bash            -bash\n  9880  99219 bash            /bin/bash',
      [
        { pid: 351, ppid: 1, command: '/lib/systemd/systemd', args: '--user' },
        { pid: 352, ppid: 351, command: '(sd-pam)', args: '' },
        {
          pid: 540,
          ppid: 1,
          command: 'sh',
          args:
            '/home/connor/.vscode-server-insiders/bin/bbf00d8ea6aa7e825ca3393364d746fe401d3299/server.sh --host=127.0.0.1 --enable-remote-auto-shutdown --port=0',
        },
        {
          pid: 548,
          ppid: 540,
          command:
            '/home/connor/.vscode-server-insiders/bin/bbf00d8ea6aa7e825ca3393364d746fe401d3299/node',
          args:
            '/home/connor/.vscode-server-insiders/bin/bbf00d8ea6aa7e825ca3393364d746fe401d3299/out/vs/server/main.js --host=127.0.0.1 --enable-remote-auto-shutdown --port=0',
        },
        { pid: 6557, ppid: 6434, command: 'sshd:', args: 'connor@notty' },
        { pid: 6558, ppid: 6557, command: 'bash', args: '' },
        { pid: 7281, ppid: 7199, command: 'sshd:', args: 'connor@pts/0' },
        { pid: 7282, ppid: 7281, command: '-bash', args: '' },
        { pid: 9880, ppid: 99219, command: '/bin/bash', args: '' },
      ],
    );
  });

  it('works for windows', async () => {
    await assertParses(
      new WindowsProcessTree(),
      '"C:\\Windows\\SystemApps\\Microsoft.Windows.Cortana_cw5n1h2txyewy\\SearchUI.exe" -ServerName:CortanaUI.AppXa50dqqa5gqv4a428c9y1jjw7m3btvepj.mca                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        20191205115356.768712-480  876              5620       \r\nC:\\Windows\\System32\\RuntimeBroker.exe -Embedding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   20191205115357.036237-480  876              2420       \r\nC:\\Windows\\system32\\ApplicationFrameHost.exe -Embedding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            20191205115357.561985-480  876              6400       \r\n"C:\\Windows\\SystemApps\\Microsoft.MicrosoftEdge_8wekyb3d8bbwe\\MicrosoftEdge.exe" -ServerName:MicrosoftEdge.AppXdnhjhccw3zf0j06tkg3jtqr00qdm0khc.mca                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 20191205115357.575393-480  876              6436       \r\n"C:\\Program Files\\WindowsApps\\Microsoft.SkypeApp_14.54.91.0_x64__kzf8qxf38zg5c\\SkypeApp.exe" -ServerName:App.AppXffn3yxqvgawq9fpmnhy90fr3y01d1t5b.mca                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              20191205115357.658285-480  876              6524       \r\n"C:\\Program Files\\WindowsApps\\Microsoft.YourPhone_1.19111.85.0_x64__8wekyb3d8bbwe\\YourPhone.exe" -ServerName:App.AppX9yct9q388jvt4h7y0gn06smzkxcsnt8m.mca                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          20191205115357.756888-480  876              6596       \r\nC:\\Windows\\system32\\browser_broker.exe -Embedding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  20191205115358.037182-480  876              6808       \r\nC:\\Windows\\System32\\RuntimeBroker.exe -Embedding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   20191205115358.290892-480  876              6972       \r\n"C:\\Windows\\System32\\MicrosoftEdgeCP.exe" -ServerName:Windows.Internal.WebRuntime.ContentProcessServer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             20191205115358.344618-480  876              7036       \r\nC:\\Windows\\system32\\MicrosoftEdgeSH.exe SCODEF:6436 CREDAT:9730 APH:1000000000000006 JITHOST /prefetch:2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           20191205115358.405124-480  6972             7088       \r\n',
      [
        {
          pid: 5620,
          ppid: 876,
          command: 'C:\\Windows\\SystemApps\\Microsoft.Windows.Cortana_cw5n1h2txyewy\\SearchUI.exe',
          args: '-ServerName:CortanaUI.AppXa50dqqa5gqv4a428c9y1jjw7m3btvepj.mca',
          date: 20191205115356,
        },
        {
          pid: 2420,
          ppid: 876,
          command: 'C:\\Windows\\System32\\RuntimeBroker.exe',
          args: '-Embedding',
          date: 20191205115357,
        },
        {
          pid: 6400,
          ppid: 876,
          command: 'C:\\Windows\\system32\\ApplicationFrameHost.exe',
          args: '-Embedding',
          date: 20191205115357,
        },
        {
          pid: 6436,
          ppid: 876,
          command:
            'C:\\Windows\\SystemApps\\Microsoft.MicrosoftEdge_8wekyb3d8bbwe\\MicrosoftEdge.exe',
          args: '-ServerName:MicrosoftEdge.AppXdnhjhccw3zf0j06tkg3jtqr00qdm0khc.mca',
          date: 20191205115357,
        },
        {
          pid: 6524,
          ppid: 876,
          command:
            'C:\\Program Files\\WindowsApps\\Microsoft.SkypeApp_14.54.91.0_x64__kzf8qxf38zg5c\\SkypeApp.exe',
          args: '-ServerName:App.AppXffn3yxqvgawq9fpmnhy90fr3y01d1t5b.mca',
          date: 20191205115357,
        },
        {
          pid: 6596,
          ppid: 876,
          command:
            'C:\\Program Files\\WindowsApps\\Microsoft.YourPhone_1.19111.85.0_x64__8wekyb3d8bbwe\\YourPhone.exe',
          args: '-ServerName:App.AppX9yct9q388jvt4h7y0gn06smzkxcsnt8m.mca',
          date: 20191205115357,
        },
        {
          pid: 6808,
          ppid: 876,
          command: 'C:\\Windows\\system32\\browser_broker.exe',
          args: '-Embedding',
          date: 20191205115358,
        },
        {
          pid: 6972,
          ppid: 876,
          command: 'C:\\Windows\\System32\\RuntimeBroker.exe',
          args: '-Embedding',
          date: 20191205115358,
        },
        {
          pid: 7036,
          ppid: 876,
          command: 'C:\\Windows\\System32\\MicrosoftEdgeCP.exe',
          args: '-ServerName:Windows.Internal.WebRuntime.ContentProcessServer',
          date: 20191205115358,
        },
        {
          pid: 7088,
          ppid: 6972,
          command: 'C:\\Windows\\system32\\MicrosoftEdgeSH.exe',
          args: 'SCODEF:6436 CREDAT:9730 APH:1000000000000006 JITHOST /prefetch:2',
          date: 20191205115358,
        },
      ],
    );
  });
});
