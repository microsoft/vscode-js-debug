import { EnvironmentVars } from '../../common/environmentVars';
import { findInPath } from '../../common/pathUtils';
import { isAbsolute } from 'path';
import { cannotFindNodeBinary, nodeBinaryOutOfDate, ProtocolError } from '../../dap/errors';
import { spawnAsync } from '../../common/processUtils';

/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

/**
 * Utility that resolves a path to Node.js and validates
 * it's a debuggable version./
 */
export class NodePathProvider {
  /**
   * A set of binary paths we know are good and which can skip additional
   * validation. We don't store bad mappings, because a user might reinstall
   * or upgrade node in-place after we tell them it's outdated.
   */
  private readonly knownGoodMappings = new Set<string>();

  /**
   * Validates the path and returns an absolute path to the Node binary to run.
   */
  public async resolveAndValidate(
    env: EnvironmentVars,
    executable: string = 'node',
  ): Promise<string> {
    const location =
      executable && isAbsolute(executable) ? executable : findInPath(executable, env.value);
    if (!location) {
      throw new ProtocolError(cannotFindNodeBinary(executable));
    }

    const knownGood = this.knownGoodMappings.has(location);
    if (knownGood) {
      return location;
    }

    // match the "12" in "v12.34.56"
    const version = await this.getVersionText(location);
    const majorVersion = /^v([0-9]+)\./.exec(version);
    if (!majorVersion || Number(majorVersion[1]) < 8) {
      throw new ProtocolError(nodeBinaryOutOfDate(version.trim(), location));
    }

    this.knownGoodMappings.add(location);
    return location;
  }

  public async getVersionText(binary: string) {
    try {
      const { stdout } = await spawnAsync(binary, ['--version']);
      return stdout;
    } catch {
      throw new ProtocolError(cannotFindNodeBinary(binary));
    }
  }
}
