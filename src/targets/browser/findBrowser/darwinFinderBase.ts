/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { injectable, inject } from 'inversify';
import { ProcessEnv, Execa, FS } from '../../../ioc-extras';
import { posix } from 'path';
import { Quality } from '.';
import { flatten } from '../../../common/objUtils';
import { escapeRegexSpecialChars } from '../../../common/stringUtils';
import _execa from 'execa';
import { promises as fsPromises } from 'fs';

/**
 * Base class providing utilities for the Darwin browser finders.
 */
@injectable()
export abstract class DarwinFinderBase {
  constructor(
    @inject(ProcessEnv) protected readonly env: NodeJS.ProcessEnv,
    @inject(Execa) private readonly execa: typeof _execa,
    @inject(FS) private readonly fs: typeof fsPromises,
  ) {}

  /**
   * Returns the environment-configured custom path, if any.
   */
  protected abstract getPreferredPath(): string | undefined;

  /**
   * Finds apps matching the given pattern in the launch service register.
   */
  protected async findLaunchRegisteredApps(
    pattern: string,
    defaultPaths: ReadonlyArray<string>,
    suffixes: ReadonlyArray<string>,
  ) {
    const lsRegister =
      '/System/Library/Frameworks/CoreServices.framework' +
      '/Versions/A/Frameworks/LaunchServices.framework' +
      '/Versions/A/Support/lsregister';

    const {
      stdout,
    } = await this.execa.command(
      `${lsRegister} -dump | grep -i '${pattern}'| awk '{$1=""; print $0}'`,
      { shell: true, stdio: 'pipe' },
    );

    const paths = [...defaultPaths, ...stdout.split('\n').map(l => l.trim())].filter(l => !!l);
    const preferred = this.getPreferredPath();
    if (preferred) {
      paths.push(preferred);
    }

    const installations = new Set<string>();
    for (const inst of paths) {
      for (const suffix of suffixes) {
        const execPath = posix.join(inst.trim(), suffix);
        try {
          await this.fs.access(execPath);
          installations.add(execPath);
        } catch (e) {
          // no access => ignored
        }
      }
    }

    return installations;
  }

  /**
   * Creates priorities for the {@link sort} function that places browsers
   * in proper order based on their installed location.
   */
  protected createPriorities(priorities: { name: string; weight: number; quality: Quality }[]) {
    const home = this.env.HOME && escapeRegexSpecialChars(this.env.HOME);
    const preferred = this.getPreferredPath();
    const mapped = flatten(
      priorities.map(p => [
        {
          regex: new RegExp(`^/Applications/.*${p.name}`),
          weight: p.weight + 100,
          quality: p.quality,
        },
        {
          regex: new RegExp(`^${home}/Applications/.*${p.name}`),
          weight: p.weight,
          quality: p.quality,
        },
        {
          regex: new RegExp(`^/Volumes/.*${p.name}`),
          weight: p.weight - 100,
          quality: p.quality,
        },
      ]),
    );

    if (preferred) {
      mapped.unshift({
        regex: new RegExp(escapeRegexSpecialChars(preferred)),
        weight: 151,
        quality: Quality.Custom,
      });
    }

    return mapped;
  }
}
