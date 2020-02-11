/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { posix } from 'path';
import { preferredChromePath, sort } from './util';
import { inject, injectable } from 'inversify';
import { ProcessEnv, FS, FsPromises } from '../../../ioc-extras';
import { execSync, execFileSync } from 'child_process';
import { homedir } from 'os';
import { IBrowserFinder, Quality } from './index';
import { escapeRegexSpecialChars } from '../../../common/stringUtils';
import { canAccess } from '../../../common/fsUtils';

const newLineRegex = /\r?\n/;

/**
 * Finds the Chrome browser on Windows.
 */
@injectable()
export class LinuxChromeBrowserFinder implements IBrowserFinder {
  constructor(
    @inject(ProcessEnv) private readonly env: NodeJS.ProcessEnv,
    @inject(FS) private readonly fs: FsPromises,
  ) {}

  public async findAll() {
    const installations = new Set<string>();

    // 1. Look into CHROME_PATH env variable
    const customChromePath = await preferredChromePath(this.fs, this.env);
    if (customChromePath) {
      installations.add(customChromePath);
    }

    // 2. Look into the directories where .desktop are saved on gnome based distro's
    const desktopInstallationFolders = [
      posix.join(homedir(), '.local/share/applications/'),
      '/usr/share/applications/',
      '/usr/bin',
    ];
    desktopInstallationFolders.forEach(folder => {
      for (const bin in this.findChromeExecutables(folder)) {
        installations.add(bin);
      }
    });

    // 3. Look for google-chrome & chromium executables by using the which command
    const executables = [
      'google-chrome-unstable',
      'google-chrome-stable',
      'google-chrome',
      'chromium-browser',
      'chromium',
    ];

    await Promise.all(
      executables.map(async executable => {
        try {
          const chromePath = execFileSync('which', [executable], { stdio: 'pipe' })
            .toString()
            .split(newLineRegex)[0];

          if (await canAccess(this.fs, chromePath)) {
            installations.add(chromePath);
          }
        } catch (e) {
          // Not installed.
        }
      }),
    );

    if (!installations.size) {
      throw new Error(
        'The environment variable CHROME_PATH must be set to executable of a build of Chromium version 54.0 or later.',
      );
    }

    const priorities = [
      { regex: /chrome-wrapper$/, weight: 52, quality: Quality.Custom },
      { regex: /google-chrome-unstable$/, weight: 51, quality: Quality.Canary },
      { regex: /google-chrome-stable$/, weight: 50, quality: Quality.Stable },
      { regex: /google-chrome$/, weight: 49, quality: Quality.Stable },
      { regex: /chromium-browser$/, weight: 48, quality: Quality.Custom },
      { regex: /chromium$/, weight: 47, quality: Quality.Custom },
    ];

    if (this.env.CHROME_PATH) {
      priorities.unshift({
        regex: new RegExp(escapeRegexSpecialChars(this.env.CHROME_PATH)),
        weight: 101,
        quality: Quality.Custom,
      });
    }

    return sort(installations, priorities);
  }

  private findChromeExecutables(folder: string) {
    const argumentsRegex = /(^[^ ]+).*/; // Take everything up to the first space
    const chromeExecRegex = '^Exec=/.*/(google-chrome|chrome|chromium)-.*';

    const installations: string[] = [];
    if (canAccess(this.fs, folder)) {
      // Output of the grep & print looks like:
      //    /opt/google/chrome/google-chrome --profile-directory
      //    /home/user/Downloads/chrome-linux/chrome-wrapper %U

      // Some systems do not support grep -R so fallback to -r.
      // See https://github.com/GoogleChrome/chrome-launcher/issues/46 for more context.
      let execResult: Buffer;
      try {
        execResult = execSync(`grep -ER "${chromeExecRegex}" ${folder} | awk -F '=' '{print $2}'`);
      } catch (e) {
        execResult = execSync(`grep -Er "${chromeExecRegex}" ${folder} | awk -F '=' '{print $2}'`);
      }

      const execPaths = execResult
        .toString()
        .split(newLineRegex)
        .map(execPath => execPath.replace(argumentsRegex, '$1'));
      execPaths.forEach(execPath => canAccess(this.fs, execPath) && installations.push(execPath));
    }

    return installations;
  }
}
