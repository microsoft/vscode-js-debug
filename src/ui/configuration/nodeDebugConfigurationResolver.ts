/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { promises as fs } from 'fs';
import { inject, injectable } from 'inversify';
import * as path from 'path';
import * as vscode from 'vscode';
import { CancellationToken } from 'vscode';
import { writeToConsole } from '../../common/console';
import { DebugType } from '../../common/contributionUtils';
import { EnvironmentVars } from '../../common/environmentVars';
import { findOpenPort } from '../../common/findOpenPort';
import { existsInjected, IFsUtils, LocalFsUtils } from '../../common/fsUtils';
import { nodeInternalsToken } from '../../common/node15Internal';
import { forceForwardSlashes, isSubpathOrEqualTo } from '../../common/pathUtils';
import { some } from '../../common/promiseUtil';
import { getNormalizedBinaryName, nearestDirectoryWhere } from '../../common/urlUtils';
import {
  AnyNodeConfiguration,
  applyNodeDefaults,
  baseDefaults,
  breakpointLanguages,
  resolveVariableInConfig,
  ResolvingNodeAttachConfiguration,
  ResolvingNodeLaunchConfiguration,
} from '../../configuration';
import { ExtensionContext } from '../../ioc-extras';
import { INvmResolver } from '../../targets/node/nvmResolver';
import { fixInspectFlags } from '../configurationUtils';
import { resolveProcessId } from '../processPicker';
import { BaseConfigurationResolver } from './baseConfigurationResolver';

type ResolvingNodeConfiguration =
  | ResolvingNodeAttachConfiguration
  | ResolvingNodeLaunchConfiguration;

/**
 * Configuration provider for node debugging. In order to allow for a
 * close to 1:1 drop-in, this is nearly identical to the original vscode-
 * node-debug, with support for some legacy options (mern, useWSL) removed.
 */
@injectable()
export class NodeConfigurationResolver extends BaseConfigurationResolver<AnyNodeConfiguration> {
  constructor(
    @inject(ExtensionContext) context: vscode.ExtensionContext,
    @inject(INvmResolver) private readonly nvmResolver: INvmResolver,
    @inject(IFsUtils) private readonly fsUtils: LocalFsUtils,
  ) {
    super(context);
  }

  /**
   * @inheritdoc
   */
  public async resolveDebugConfigurationWithSubstitutedVariables(
    _folder: vscode.WorkspaceFolder | undefined,
    rawConfig: vscode.DebugConfiguration,
  ): Promise<vscode.DebugConfiguration | undefined> {
    const config = rawConfig as AnyNodeConfiguration;
    if (
      config.type === DebugType.Node
      && config.request === 'attach'
      && typeof config.processId === 'string'
    ) {
      await resolveProcessId(this.fsUtils, config);
    }

    if ('port' in config && typeof config.port === 'string') {
      config.port = Number(config.port);
    }
    if ('attachSimplePort' in config && typeof config.attachSimplePort === 'string') {
      config.attachSimplePort = Number(config.attachSimplePort);
    }

    // check that the cwd is valid to avoid mysterious ENOENTs (vscode#133310)
    if (config.cwd) {
      const stats = await existsInjected(fs, config.cwd);
      if (!stats) {
        vscode.window.showErrorMessage(
          l10n.t('The configured `cwd` {0} does not exist.', config.cwd),
          { modal: true },
        );
        return;
      }

      if (!stats.isDirectory()) {
        vscode.window.showErrorMessage(
          l10n.t('The configured `cwd` {0} is not a folder.', config.cwd),
          { modal: true },
        );
        return;
      }
    }

    return config;
  }

  /**
   * @override
   */
  protected async resolveDebugConfigurationAsync(
    folder: vscode.WorkspaceFolder | undefined,
    config: ResolvingNodeConfiguration,
    cancellationToken: CancellationToken,
  ): Promise<AnyNodeConfiguration | undefined> {
    if (!config.name && !config.type && !config.request) {
      config = await createLaunchConfigFromContext(folder, true, config);
      if (config.request === 'launch' && !config.program) {
        vscode.window.showErrorMessage(l10n.t('Cannot find a program to debug'), {
          modal: true,
        });
        return;
      }
    }

    // make sure that config has a 'cwd' attribute set
    if (!config.cwd) {
      config.cwd = config.localRoot // https://github.com/microsoft/vscode-js-debug/issues/894#issuecomment-745449195
        || guessWorkingDirectory(config.request === 'launch' ? config.program : undefined, folder);
    }

    // if a 'remoteRoot' is specified without a corresponding 'localRoot', set 'localRoot' to the workspace folder.
    // see https://github.com/Microsoft/vscode/issues/63118
    if (config.remoteRoot && !config.localRoot) {
      config.localRoot = '${workspaceFolder}';
    }

    if (config.request === 'launch') {
      // custom node install
      this.applyDefaultRuntimeExecutable(config);

      // Deno does not support NODE_OPTIONS, so if we see it, try to set the
      // necessary options automatically.
      if (
        config.runtimeExecutable
        && getNormalizedBinaryName(config.runtimeExecutable) === 'deno'
      ) {
        // If the user manually set up attachSimplePort, do nothing.
        if (!config.attachSimplePort) {
          const port = await findOpenPort();
          config.attachSimplePort = port;
          config.continueOnAttach ??= true;

          const runtimeArgs = [`--inspect-brk=127.0.0.1:${port}`, '--allow-all'];
          if (!config.runtimeArgs) {
            config.runtimeArgs = ['run', ...runtimeArgs];
          } else if (!config.runtimeArgs.includes('run')) {
            config.runtimeArgs = ['run', ...runtimeArgs, ...config.runtimeArgs];
          } else {
            config.runtimeArgs = [...config.runtimeArgs, ...runtimeArgs];
          }
        }
      }

      // nvm support
      const nvmVersion = config.runtimeVersion;
      if (typeof nvmVersion === 'string' && nvmVersion !== 'default') {
        const { directory, binary } = await this.nvmResolver.resolveNvmVersionPath(nvmVersion);
        config.env = new EnvironmentVars(config.env).addToPath(directory, 'prepend', true).value;
        config.runtimeExecutable = !config.runtimeExecutable || config.runtimeExecutable === 'node'
          ? binary
          : config.runtimeExecutable;
      }

      // when using "integratedTerminal" ensure that debug console doesn't get activated; see https://github.com/Microsoft/vscode/issues/43164
      if (config.console === 'integratedTerminal' && !config.internalConsoleOptions) {
        config.internalConsoleOptions = 'neverOpen';
      }

      // assign a random debug port if requested, otherwise remove manual
      // --inspect-brk flags, which are no longer needed and interfere
      if (config.attachSimplePort === null || config.attachSimplePort === undefined) {
        fixInspectFlags(config);
      } else {
        if (config.attachSimplePort === 0) {
          config.attachSimplePort = await findOpenPort(undefined, cancellationToken);
          const arg = `--inspect-brk=${config.attachSimplePort}`;
          config.runtimeArgs = config.runtimeArgs ? [...config.runtimeArgs, arg] : [arg];
        }

        config.continueOnAttach = !config.stopOnEntry;
        config.stopOnEntry = false; // handled by --inspect-brk
      }

      // update outfiles to the nearest package root
      await guessOutFiles(this.fsUtils, folder, config);
    }

    return applyNodeDefaults(config);
  }

  protected getType() {
    return DebugType.Node as const;
  }

  /**
   * @override
   */
  protected getSuggestedWorkspaceFolders(config: AnyNodeConfiguration) {
    return [config.rootPath, config.cwd];
  }
}

export function guessWorkingDirectory(program?: string, folder?: vscode.WorkspaceFolder): string {
  if (folder) {
    return folder.uri.fsPath;
  }

  // no folder -> config is a user or workspace launch config
  if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
    return vscode.workspace.workspaceFolders[0].uri.fsPath;
  }

  // no folder case
  if (program) {
    if (program === '${file}') {
      return '${fileDirname}';
    }

    // program is some absolute path
    if (path.isAbsolute(program)) {
      // derive 'cwd' from 'program'
      return path.dirname(program);
    }
  }

  // last resort
  return '${workspaceFolder}';
}

function getAbsoluteLocation(folder: vscode.WorkspaceFolder | undefined, relpath: string) {
  if (folder) {
    relpath = resolveVariableInConfig(relpath, 'workspaceFolder', folder.uri.fsPath);
  }

  if (vscode.workspace.workspaceFolders?.length) {
    relpath = resolveVariableInConfig(
      relpath,
      'workspaceRoot',
      vscode.workspace.workspaceFolders[0].uri.fsPath,
    );
  }

  if (path.isAbsolute(relpath)) {
    return relpath;
  }

  if (folder) {
    return path.join(folder.uri.fsPath, relpath);
  }

  return undefined;
}

/**
 * Set the outFiles to the nearest package.json-containing folder relative
 * to the program, if it's not already included in the workspace folder.
 *
 * This used to narrow (#326), but I think this is undesirable behavior for
 * most users (vscode#142641), so now it only widens the `outFiles`.
 */
async function guessOutFiles(
  fsUtils: LocalFsUtils,
  folder: vscode.WorkspaceFolder | undefined,
  config: ResolvingNodeLaunchConfiguration,
) {
  if (config.outFiles || !folder) {
    return;
  }

  let programLocation: string | undefined;
  if (config.program) {
    programLocation = getAbsoluteLocation(folder, config.program);
    if (programLocation) {
      programLocation = path.dirname(programLocation);
    }
  } else if (config.cwd) {
    programLocation = getAbsoluteLocation(folder, config.cwd);
  }

  if (!programLocation || isSubpathOrEqualTo(folder.uri.fsPath, programLocation)) {
    return;
  }

  const root = await nearestDirectoryWhere(
    programLocation,
    async p =>
      !p.includes('node_modules') && (await fsUtils.exists(path.join(p, 'package.json')))
        ? p
        : undefined,
  );

  if (root) {
    const rel = forceForwardSlashes(path.relative(folder.uri.fsPath, root));
    if (rel.length) {
      config.outFiles = [
        ...baseDefaults.outFiles,
        `\${workspaceFolder}/${rel}/**/*.js`,
        `!\${workspaceFolder}/${rel}/**/node_modules/**`,
      ];
    }
  }
}

interface ITSConfig {
  compilerOptions?: {
    outDir: string;
  };
}

interface IPartialPackageJson {
  name?: string;
  main?: string;
  scripts?: { [key: string]: string };
}

const commonEntrypoints = ['index.js', 'main.js'];

export async function createLaunchConfigFromContext(
  folder: vscode.WorkspaceFolder | undefined,
  resolve: boolean,
  existingConfig?: ResolvingNodeConfiguration,
): Promise<ResolvingNodeConfiguration> {
  const config: ResolvingNodeConfiguration = {
    type: DebugType.Node,
    request: 'launch',
    name: l10n.t('Launch Program'),
    skipFiles: [`${nodeInternalsToken}/**`],
  };

  if (existingConfig && existingConfig.noDebug) {
    config.noDebug = true;
  }

  const pkg = await loadJSON<IPartialPackageJson>(folder, 'package.json');
  let program: string | undefined;
  let useSourceMaps = false;

  if (pkg && pkg.name === 'mern-starter') {
    if (resolve) {
      writeToConsole(l10n.t("Launch configuration for '{0}' project created.", 'Mern Starter'));
    }
    configureMern(config);
    return config;
  }

  if (pkg) {
    // try to find a value for 'program' by analysing package.json
    program = await guessProgramFromPackage(folder, pkg, resolve);
    if (program && resolve) {
      writeToConsole(l10n.t("Launch configuration created based on 'package.json'."));
    }
  }

  if (!program) {
    // try to use file open in editor
    const editor = vscode.window.activeTextEditor;
    if (editor && breakpointLanguages.includes(editor.document.languageId)) {
      useSourceMaps = editor.document.languageId !== 'javascript';
      program = folder
        ? path.relative(folder.uri.fsPath, editor.document.uri.fsPath)
        : editor.document.uri.fsPath;

      if (!path.isAbsolute(program)) {
        // we don't use path.join here since it destroys the workspaceFolder with ../ (vscode#125796)
        program = '${workspaceFolder}' + path.sep + program;
      }
    }
  }

  if (!program && folder) {
    const basePath = folder.uri.fsPath;
    program = await some(
      commonEntrypoints.map(
        async file =>
          (await existsInjected(fs, path.join(basePath, file)))
          && '${workspaceFolder}' + path.sep + file,
      ),
    );
  }

  // just use `${file}` which'll prompt the user to open an active file
  if (!program) {
    program = '${file}';
  }

  if (program) {
    config.program = program;

    if (!folder) {
      config.__workspaceFolder = path.dirname(program);
    }
  }

  // prepare for source maps by adding 'outFiles' if typescript or coffeescript is detected
  if (
    useSourceMaps
    || vscode.workspace.textDocuments.some(document => isTranspiledLanguage(document.languageId))
  ) {
    if (resolve) {
      writeToConsole(
        l10n.t(
          "Adjust glob pattern(s) in the 'outFiles' attribute so that they cover the generated JavaScript.",
        ),
      );
    }

    let dir = '';
    const tsConfig = await loadJSON<ITSConfig>(folder, 'tsconfig.json');
    if (tsConfig?.compilerOptions?.outDir && canDetectTsBuildTask()) {
      const outDir = tsConfig.compilerOptions.outDir;
      if (!path.isAbsolute(outDir)) {
        dir = outDir;
        if (dir.indexOf('./') === 0) {
          dir = dir.substr(2);
        }
        if (dir[dir.length - 1] !== '/') {
          dir += '/';
        }
      }
      config.preLaunchTask = 'tsc: build - tsconfig.json';
    }
    config['outFiles'] = ['${workspaceFolder}/' + dir + '**/*.js'];
  }

  return config;
}

function canDetectTsBuildTask() {
  const value = vscode.workspace.getConfiguration().get('typescript.tsc.autoDetect');
  return value !== 'off' && value !== 'watch';
}

function configureMern(config: ResolvingNodeConfiguration) {
  if (config.request !== 'launch') {
    return;
  }

  config.runtimeExecutable = 'nodemon';
  config.program = '${workspaceFolder}/index.js';
  config.restart = true;
  config.env = { BABEL_DISABLE_CACHE: '1', NODE_ENV: 'development' };
  config.console = 'integratedTerminal';
  config.internalConsoleOptions = 'neverOpen';
}

function isTranspiledLanguage(languagId: string): boolean {
  return languagId === 'typescript' || languagId === 'coffeescript';
}

async function loadJSON<T>(
  folder: vscode.WorkspaceFolder | undefined,
  file: string,
): Promise<T | undefined> {
  if (folder) {
    try {
      const content = await fs.readFile(path.join(folder.uri.fsPath, file), 'utf8');
      return JSON.parse(content);
    } catch (error) {
      // silently ignore
    }
  }
  return undefined;
}
/*
 * try to find the entry point ('main') from the package.json
 */
async function guessProgramFromPackage(
  folder: vscode.WorkspaceFolder | undefined,
  packageJson: IPartialPackageJson,
  resolve: boolean,
): Promise<string | undefined> {
  let program: string | undefined;

  try {
    if (packageJson.main) {
      program = packageJson.main;
    } else if (packageJson.scripts && typeof packageJson.scripts.start === 'string') {
      // assume a start script of the form 'node server.js'
      program = packageJson.scripts.start.split(' ').pop();
    }

    if (program) {
      let targetPath: string | undefined;
      if (path.isAbsolute(program)) {
        targetPath = program;
      } else {
        targetPath = folder ? path.join(folder.uri.fsPath, program) : undefined;
        program = path.join('${workspaceFolder}', program);
      }
      if (
        resolve
        && targetPath
        && !(await existsInjected(fs, targetPath))
        && !(await existsInjected(fs, targetPath + '.js'))
      ) {
        return undefined;
      }
    }
  } catch (error) {
    // silently ignore
  }

  return program;
}
