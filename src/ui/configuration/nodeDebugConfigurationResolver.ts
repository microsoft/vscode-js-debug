/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as nls from 'vscode-nls';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { writeToConsole } from '../../common/console';
import {
  ResolvingNodeAttachConfiguration,
  ResolvingNodeLaunchConfiguration,
  AnyNodeConfiguration,
  resolveVariableInConfig,
  baseDefaults,
  applyNodeDefaults,
  breakpointLanguages,
} from '../../configuration';
import { DebugType } from '../../common/contributionUtils';
import { INvmResolver } from '../../targets/node/nvmResolver';
import { EnvironmentVars } from '../../common/environmentVars';
import { BaseConfigurationResolver } from './baseConfigurationResolver';
import { fixInspectFlags } from '../configurationUtils';
import { injectable, inject } from 'inversify';
import { ExtensionContext } from '../../ioc-extras';
import { nearestDirectoryContaining } from '../../common/urlUtils';
import { isSubdirectoryOf, forceForwardSlashes } from '../../common/pathUtils';
import { resolveProcessId } from '../processPicker';

const localize = nls.loadMessageBundle();

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
  ) {
    super(context);
  }

  /**
   * @inheritdoc
   */
  public async resolveDebugConfigurationWithSubstitutedVariables(
    folder: vscode.WorkspaceFolder | undefined,
    rawConfig: vscode.DebugConfiguration,
  ): Promise<vscode.DebugConfiguration> {
    const config = rawConfig as AnyNodeConfiguration;
    if (
      config.type === DebugType.Node &&
      config.request === 'attach' &&
      typeof config.processId === 'string'
    ) {
      await resolveProcessId(config);
    }

    return config;
  }

  /**
   * @override
   */
  protected async resolveDebugConfigurationAsync(
    folder: vscode.WorkspaceFolder | undefined,
    config: ResolvingNodeConfiguration,
  ): Promise<AnyNodeConfiguration | undefined> {
    if (!config.name && !config.type && !config.request) {
      config = createLaunchConfigFromContext(folder, true, config);
      if (config.request === 'launch' && !config.program) {
        vscode.window.showErrorMessage(
          localize('program.not.found.message', 'Cannot find a program to debug'),
          { modal: true },
        );
        return;
      }
    }

    // make sure that config has a 'cwd' attribute set
    if (!config.cwd) {
      config.cwd = guessWorkingDirectory(
        config.request === 'launch' ? config.program : undefined,
        folder,
      );
    }

    // if a 'remoteRoot' is specified without a corresponding 'localRoot', set 'localRoot' to the workspace folder.
    // see https://github.com/Microsoft/vscode/issues/63118
    if (config.remoteRoot && !config.localRoot) {
      config.localRoot = '${workspaceFolder}';
    }

    if (config.request === 'launch') {
      // nvm support
      const nvmVersion = config.runtimeVersion;
      if (typeof nvmVersion === 'string' && nvmVersion !== 'default') {
        const { directory, binary } = await this.nvmResolver.resolveNvmVersionPath(nvmVersion);
        config.env = new EnvironmentVars(config.env).addToPath(directory).value;
        config.runtimeExecutable =
          !config.runtimeExecutable || config.runtimeExecutable === 'node'
            ? binary
            : config.runtimeExecutable;
      }

      // when using "integratedTerminal" ensure that debug console doesn't get activated; see https://github.com/Microsoft/vscode/issues/43164
      if (config.console === 'integratedTerminal' && !config.internalConsoleOptions) {
        config.internalConsoleOptions = 'neverOpen';
      }

      // remove manual --inspect-brk flags, which are no longer needed and interfere
      fixInspectFlags(config);

      // update outfiles to the nearest package root
      await guessOutFiles(folder, config);
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

function getAbsoluteProgramLocation(folder: vscode.WorkspaceFolder | undefined, program: string) {
  if (folder) {
    program = resolveVariableInConfig(program, 'workspaceFolder', folder.uri.fsPath);
  }

  if (path.isAbsolute(program)) {
    return program;
  }

  if (folder) {
    return path.join(folder.uri.fsPath, program);
  }

  return undefined;
}

/**
 * Set the outFiles to the nearest package.json-containing folder relative
 * to the program, if we can find one within the workspace folder. This speeds
 * things up significantly in monorepos.
 * @see https://github.com/microsoft/vscode-js-debug/issues/326
 */
async function guessOutFiles(
  folder: vscode.WorkspaceFolder | undefined,
  config: ResolvingNodeLaunchConfiguration,
) {
  if (config.outFiles || !config.program || !folder) {
    return;
  }

  const programLocation = getAbsoluteProgramLocation(folder, config.program);
  if (!programLocation) {
    return;
  }

  const root = await nearestDirectoryContaining(path.dirname(programLocation), 'package.json');
  if (root && isSubdirectoryOf(folder.uri.fsPath, root)) {
    const rel = forceForwardSlashes(path.relative(folder.uri.fsPath, root));
    config.outFiles = resolveVariableInConfig(
      baseDefaults.outFiles,
      'workspaceFolder',
      `\${workspaceFolder}/${rel}`,
    );
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

export function createLaunchConfigFromContext(
  folder: vscode.WorkspaceFolder | undefined,
  resolve: boolean,
  existingConfig?: ResolvingNodeConfiguration,
): ResolvingNodeConfiguration {
  const config: ResolvingNodeConfiguration = {
    type: DebugType.Node,
    request: 'launch',
    name: localize('node.launch.config.name', 'Launch Program'),
    skipFiles: ['<node_internals>/**'],
  };

  if (existingConfig && existingConfig.noDebug) {
    config.noDebug = true;
  }

  const pkg = loadJSON<IPartialPackageJson>(folder, 'package.json');
  let program: string | undefined;
  let useSourceMaps = false;

  if (pkg && pkg.name === 'mern-starter') {
    if (resolve) {
      writeToConsole(
        localize(
          'mern.starter.explanation',
          "Launch configuration for '{0}' project created.",
          'Mern Starter',
        ),
      );
    }
    configureMern(config);
    return config;
  }

  if (pkg) {
    // try to find a value for 'program' by analysing package.json
    program = guessProgramFromPackage(folder, pkg, resolve);
    if (program && resolve) {
      writeToConsole(
        localize(
          'program.guessed.from.package.json.explanation',
          "Launch configuration created based on 'package.json'.",
        ),
      );
    }
  }

  if (!program) {
    // try to use file open in editor
    const editor = vscode.window.activeTextEditor;
    if (editor && breakpointLanguages.includes(editor.document.languageId)) {
      useSourceMaps = editor.document.languageId !== 'javascript';
      program = folder
        ? path.join(
            '${workspaceFolder}',
            path.relative(folder.uri.fsPath, editor.document.uri.fsPath),
          )
        : editor.document.uri.fsPath;
    }
  }

  // if we couldn't find a value for 'program', we just let the launch config use the file open in the editor
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
    useSourceMaps ||
    vscode.workspace.textDocuments.some(document => isTranspiledLanguage(document.languageId))
  ) {
    if (resolve) {
      writeToConsole(
        localize(
          'outFiles.explanation',
          "Adjust glob pattern(s) in the 'outFiles' attribute so that they cover the generated JavaScript.",
        ),
      );
    }

    let dir = '';
    const tsConfig = loadJSON<ITSConfig>(folder, 'tsconfig.json');
    if (tsConfig && tsConfig.compilerOptions && tsConfig.compilerOptions.outDir) {
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

function loadJSON<T>(folder: vscode.WorkspaceFolder | undefined, file: string): T | void {
  if (folder) {
    try {
      const content = fs.readFileSync(path.join(folder.uri.fsPath, file), 'utf8');
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
function guessProgramFromPackage(
  folder: vscode.WorkspaceFolder | undefined,
  packageJson: IPartialPackageJson,
  resolve: boolean,
): string | undefined {
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
        resolve &&
        targetPath &&
        !fs.existsSync(targetPath) &&
        !fs.existsSync(targetPath + '.js')
      ) {
        return undefined;
      }
    }
  } catch (error) {
    // silently ignore
  }

  return program;
}
