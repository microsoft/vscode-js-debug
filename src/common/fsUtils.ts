/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as fs from 'fs';
import * as util from 'util';
import Dap from '../dap/api';
import { FsPromises } from '../ioc-extras';

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

export async function copyFile(fs: FsPromises, fromPath: string, toPath: string) {
  // Beautiful try-catch's. First try to copy the file simply, if that fails see
  // if it exists, and if so delete and re-copy it. This fixes a NixOS issue, #1057
  try {
    await fs.copyFile(fromPath, toPath);
  } catch (eOriginal) {
    try {
      if (await canAccess(fs, toPath)) {
        await fs.unlink(toPath);
        await fs.copyFile(fromPath, toPath);
      } else {
        throw eOriginal;
      }
    } catch {
      throw eOriginal;
    }
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
  /**
   * Gets whether the file exists.
   */
  exists(path: string): Promise<boolean>;

  /**
   * Gets un-linked path of the file on disk.
   * @throws if the path does not exist
   */
  realPath(path: string): Promise<string>;

  /**
   * Gets the file contents.
   * @throws if the path does not exist
   */
  readFile(path: string): Promise<Buffer>;
}

/**
 * Injection for the `IFsUtils` interface.
 */
export const IFsUtils = Symbol('FsUtils');

export class LocalFsUtils implements IFsUtils {
  public constructor(private readonly fs: FsPromises) {}

  public realPath(path: string): Promise<string> {
    return this.fs.realpath(path);
  }

  public async exists(path: string): Promise<boolean> {
    // Check if the file exists in the current directory.
    try {
      await this.fs.access(path, fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  public readFile(path: string) {
    return this.fs.readFile(path);
  }
}

export class RemoteFsThroughDapUtils implements IFsUtils {
  public constructor(private readonly dap: Dap.Api) {}

  public async realPath(): Promise<string> {
    throw new Error('not implemented');
  }

  public async exists(path: string): Promise<boolean> {
    try {
      const { doesExists } = await this.dap.remoteFileExistsRequest({
        localFilePath: path,
      });
      return doesExists;
    } catch {
      return false;
    }
  }

  public readFile(): never {
    throw new Error('not implemented');
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
      return new this(
        remoteFilePrefix.toLowerCase(),
        localFsUtils,
        new RemoteFsThroughDapUtils(dap),
      );
    } else {
      return localFsUtils;
    }
  }

  public async exists(path: string): Promise<boolean> {
    return this.selectFs(path).exists(path);
  }

  public async readFile(path: string): Promise<Buffer> {
    return this.selectFs(path).readFile(path);
  }

  public async realPath(path: string): Promise<string> {
    return this.selectFs(path).realPath(path);
  }

  public selectFs(path: string) {
    return path.toLowerCase().startsWith(this.remoteFilePrefix)
      ? this.remoteFsUtils
      : this.localFsUtils;
  }
}
