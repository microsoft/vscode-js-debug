// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as nls from 'vscode-nls';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { writeToConsole } from './common/console';
import {
  nodeAttachConfigDefaults,
  nodeLaunchConfigDefaults,
  ResolvingNodeAttachConfiguration,
  ResolvingNodeLaunchConfiguration,
  ResolvedConfiguration,
} from './configuration';
import { Contributions } from './common/contributionUtils';
import { NvmResolver, INvmResolver } from './targets/node/nvmResolver';
import { EnvironmentVars } from './common/environmentVars';
import { resolveProcessId } from './ui/processPicker';
import { BaseConfigurationProvider } from './baseConfigurationProvider';

const localize = nls.loadMessageBundle();

const breakpointLanguages: ReadonlyArray<
  string
> = require('../../package.json').contributes.breakpoints.map(
  (b: { language: string }) => b.language,
);

type ResolvingNodeConfiguration =
  | ResolvingNodeAttachConfiguration
  | ResolvingNodeLaunchConfiguration;

/**
 * Configuration provider for node debugging. In order to allow for a
 * close to 1:1 drop-in, this is nearly identical to the original vscode-
 * node-debug, with support for some legacy options (mern, useWSL) removed.
 */
export class NodeDebugConfigurationProvider
  extends BaseConfigurationProvider<ResolvingNodeConfiguration>
  implements vscode.DebugConfigurationProvider {
  constructor(
    context: vscode.ExtensionContext,
    private readonly nvmResolver: INvmResolver = new NvmResolver(),
  ) {
    super(context);
  }

  protected async resolveDebugConfigurationAsync(
    folder: vscode.WorkspaceFolder | undefined,
    config: ResolvingNodeConfiguration,
  ): Promise<ResolvedConfiguration<ResolvingNodeConfiguration> | undefined> {
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
      config.cwd = guessWorkingDirectory(config, folder);
    }

    // if a 'remoteRoot' is specified without a corresponding 'localRoot', set 'localRoot' to the workspace folder.
    // see https://github.com/Microsoft/vscode/issues/63118
    if (config.remoteRoot && !config.localRoot) {
      config.localRoot = '${workspaceFolder}';
    }

    if (config.request === 'launch') {
      // nvm support
      if (typeof config.runtimeVersion === 'string' && config.runtimeVersion !== 'default') {
        config.env = new EnvironmentVars(config.env).addToPath(
          await this.nvmResolver.resolveNvmVersionPath(config.runtimeVersion),
        ).value;
      }

      // when using "integratedTerminal" ensure that debug console doesn't get activated; see https://github.com/Microsoft/vscode/issues/43164
      if (config.console === 'integratedTerminal' && !config.internalConsoleOptions) {
        config.internalConsoleOptions = 'neverOpen';
      }
    }

    // "attach to process via picker" support
    if (config.request === 'attach' && typeof config.processId === 'string') {
      if (!(await resolveProcessId(config))) {
        return undefined; // abort launch
      }
    }

    return config.request === 'attach'
      ? { ...nodeAttachConfigDefaults, ...config }
      : { ...nodeLaunchConfigDefaults, ...config };
  }
}

export function guessWorkingDirectory(
  config: ResolvingNodeConfiguration,
  folder?: vscode.WorkspaceFolder,
): string {
  if (folder) {
    return folder.uri.fsPath;
  }

  // no folder -> config is a user or workspace launch config
  if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
    return vscode.workspace.workspaceFolders[0].uri.fsPath;
  }

  // no folder case
  if (config.request === 'launch') {
    if (config.program === '${file}') {
      return '${fileDirname}';
    }

    // program is some absolute path
    if (config.program && path.isAbsolute(config.program)) {
      // derive 'cwd' from 'program'
      return path.dirname(config.program);
    }
  }

  // last resort
  return '${workspaceFolder}';
}

function createLaunchConfigFromContext(
  folder: vscode.WorkspaceFolder | undefined,
  resolve: boolean,
  existingConfig?: ResolvingNodeConfiguration,
): ResolvingNodeConfiguration {
  const config: ResolvingNodeConfiguration = {
    type: Contributions.NodeDebugType,
    request: 'launch',
    name: localize('node.launch.config.name', 'Launch Program'),
    skipFiles: ['<node_internals>/**'],
  };

  if (existingConfig && existingConfig.noDebug) {
    config.noDebug = true;
  }

  const pkg = loadJSON(folder, 'package.json');
  let program: string | undefined;
  let useSourceMaps = false;

  if (pkg && pkg.name === 'mern-starter') {
    if (resolve) {
      writeToConsole(
        localize(
          {
            key: 'mern.starter.explanation',
            comment: ['argument contains product name without translation'],
          },
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
    config['program'] = program;
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
    const tsConfig = loadJSON(folder, 'tsconfig.json');
    if (tsConfig && tsConfig.compilerOptions && tsConfig.compilerOptions.outDir) {
      const outDir = <string>tsConfig.compilerOptions.outDir;
      if (!path.isAbsolute(outDir)) {
        dir = outDir;
        if (dir.indexOf('./') === 0) {
          dir = dir.substr(2);
        }
        if (dir[dir.length - 1] !== '/') {
          dir += '/';
        }
      }
      (config as any)['preLaunchTask'] = 'tsc: build - tsconfig.json';
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

function loadJSON(folder: vscode.WorkspaceFolder | undefined, file: string): any {
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
  packageJson: any,
  resolve: boolean,
): string | undefined {
  let program: string | undefined;

  try {
    if (packageJson.main) {
      program = packageJson.main;
    } else if (packageJson.scripts && typeof packageJson.scripts.start === 'string') {
      // assume a start script of the form 'node server.js'
      program = (<string>packageJson.scripts.start).split(' ').pop();
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
