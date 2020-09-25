/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { inject, injectable } from 'inversify';
import { join } from 'path';
import { DebugType } from '../../common/contributionUtils';
import { IFsUtils } from '../../common/fsUtils';
import { once } from '../../common/objUtils';
import { nearestDirectoryContaining } from '../../common/urlUtils';
import { AnyLaunchConfiguration } from '../../configuration';

export interface IPackageJson {
  scripts?: {
    [name: string]: string;
  };
  dependencies?: {
    [name: string]: string;
  };
  devDependencies?: {
    [name: string]: string;
  };
}

export interface IPackageJsonProvider {
  /**
   * Gets the path for the package.json associated with the current launched program.
   */
  getPath(): Promise<string | undefined>;

  /**
   * Gets the path for the package.json associated with the current launched program.
   */
  getContents(): Promise<IPackageJson | undefined>;
}

export const IPackageJsonProvider = Symbol('IPackageJsonProvider');

/**
 * A package.json provider that never returns path or contents.
 */
export const noPackageJsonProvider = {
  getPath: () => Promise.resolve(undefined),
  getContents: () => Promise.resolve(undefined),
};

@injectable()
export class PackageJsonProvider implements IPackageJsonProvider {
  constructor(
    @inject(IFsUtils) private readonly fs: IFsUtils,
    @inject(AnyLaunchConfiguration) private readonly config: AnyLaunchConfiguration,
  ) {}

  /**
   * Gets the package.json for the debugged program.
   */
  public readonly getPath = once(async () => {
    if (this.config.type !== DebugType.Node || this.config.request !== 'launch') {
      return;
    }

    const dir = await nearestDirectoryContaining(this.fs, this.config.cwd, 'package.json');
    return dir ? join(dir, 'package.json') : undefined;
  });

  /**
   * Gets the package.json contents for the debugged program.
   */
  public readonly getContents = once(async () => {
    const path = await this.getPath();
    if (!path) {
      return;
    }

    try {
      const contents = await this.fs.readFile(path);
      return JSON.parse(contents.toString()) as IPackageJson;
    } catch {
      return;
    }
  });
}
