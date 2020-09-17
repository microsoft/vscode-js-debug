/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as fs from 'fs';
import * as util from 'util';
import { FsPromises } from '../ioc-extras';
import Dap from '../dap/api';

export const fsModule = fs;

/**
 * Returns whether the user can access the given file path.
 */
export async function canAccess({ access }: FsPromises, file: string | undefined | null) {
  if (!file) {
    return false;
  }

  try {
    await access(file);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Returns whether the user can access the given file path.
 */
export async function existsInjected(
  { stat }: FsPromises,
  file: string | undefined | null,
): Promise<fs.Stats | undefined> {
  if (!file) {
    return;
  }

  try {
    return await stat(file);
  } catch (e) {
    return;
  }
}

/**
 * Returns the file path exists without derefencing symblinks.
 */
export async function existsWithoutDeref(
  { lstat }: FsPromises,
  file: string | undefined | null,
): Promise<fs.Stats | undefined> {
  if (!file) {
    return;
  }

  try {
    return await lstat(file);
  } catch (e) {
    return;
  }
}

/**
 * Moves the file from the source to destination.
 */
export async function moveFile(
  { copyFile, rename, unlink }: FsPromises,
  src: string,
  dest: string,
) {
  try {
    await rename(src, dest);
  } catch {
    await copyFile(src, dest);
    await unlink(src);
  }
}

export function stat(path: string): Promise<fs.Stats | undefined> {
  return new Promise(cb => {
    fs.stat(path, (err, stat) => {
      return cb(err ? undefined : stat);
    });
  });
}

export function readdir(path: string): Promise<string[]> {
  return new Promise(cb => {
    fs.readdir(path, 'utf8', async (err, entries) => {
      cb(err ? [] : entries);
    });
  });
}

export function readfile(path: string): Promise<string> {
  return new Promise(cb => {
    fs.readFile(path, 'utf8', async (err, content) => {
      cb(err ? '' : content);
    });
  });
}

export const writeFile = util.promisify(fs.writeFile);

export function readFileRaw(path: string): Promise<Buffer> {
  return fs.promises.readFile(path).catch(() => Buffer.alloc(0));
}

export interface IFsUtils {
  exists(path: string): Promise<boolean>;
}

/**
 * Injection for the `IFsUtils` interface.
 */
export const IFsUtils = Symbol('FsUtils');

export class LocalFsUtils implements IFsUtils {
  public constructor(private readonly fs: FsPromises) {}

  public async exists(path: string): Promise<boolean> {
    // Check if the file exists in the current directory.
    try {
      if (process.platform === 'darwin') {
        return fs.existsSync(path); // One of the unit tests fails on OSX
      } else {
        await this.fs.access(path, fs.constants.F_OK);
        return true;
      }
    } catch {
      return false;
    }
  }
}

export class RemoteFsThroughDapUtils implements IFsUtils {
  public constructor(private readonly dap: Dap.Api) {}

  public async exists(path: string): Promise<boolean> {
    try {
      // Custom request
      const { doesExists } = await this.dap.remoteFileExistsRequest({
        localFilePath: path,
      });
      return doesExists;
    } catch {
      return false;
    }
  }
}

/**
 * Notes: remoteFilePrefix = '' // will do all fs operations thorugh DAP requests
 * remoteFilePrefix = undefined // will do all operations thorugh Local Node.fs
 */
export class LocalAndRemoteFsUtils implements IFsUtils {
  private constructor(
    private readonly remoteFilePrefix: string,
    private readonly localFsUtils: IFsUtils,
    private readonly remoteFsUtils: IFsUtils,
  ) {}

  public static create(
    remoteFilePrefix: string | undefined,
    fsPromises: FsPromises,
    dap: Dap.Api,
  ): IFsUtils {
    const localFsUtils = new LocalFsUtils(fsPromises);
    if (remoteFilePrefix !== undefined) {
      return new this(remoteFilePrefix, localFsUtils, new RemoteFsThroughDapUtils(dap));
    } else {
      return localFsUtils;
    }
  }

  public async exists(path: string): Promise<boolean> {
    return (this.shouldUseRemoteFileSystem(path) ? this.remoteFsUtils : this.localFsUtils).exists(
      path,
    );
  }

  public shouldUseRemoteFileSystem(path: string) {
    return path.startsWith(this.remoteFilePrefix);
  }
}
