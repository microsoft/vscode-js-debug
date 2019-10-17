/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as nls from 'vscode-nls';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { writeToConsole } from './common/console';
import {
  INodeLaunchConfiguration,
  ResolvingNodeConfiguration,
  nodeAttachConfigDefaults,
  nodeLaunchConfigDefaults,
  AnyNodeConfiguration,
} from './configuration';
import { Contributions } from './common/contributionUtils';

const localize = nls.loadMessageBundle();

/**
 * Configuration provider for node debugging. In order to allow for a
 * close to 1:1 drop-in, this is nearly identical to the original vscode-
 * node-debug, with support for some legacy options (mern, useWSL) removed.
 */
export class NodeDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
  /**
   * Try to add all missing attributes to the debug configuration being launched.
   */
  public async resolveDebugConfiguration(
    folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration,
  ): Promise<vscode.DebugConfiguration | undefined> {
    try {
      return this.resolveDebugConfigurationAsync(folder, config as ResolvingNodeConfiguration);
    } catch (err) {
      await vscode.window.showErrorMessage(err.message, { modal: true });
      return;
    }
  }

  private async resolveDebugConfigurationAsync(
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
        await resolveNvmVersion(config);
      }
      // when using "integratedTerminal" ensure that debug console doesn't get activated; see https://github.com/Microsoft/vscode/issues/43164
      if (config.console === 'integratedTerminal' && !config.internalConsoleOptions) {
        config.internalConsoleOptions = 'neverOpen';
      }

      // read environment variables from any specified file
      if (config.envFile) {
        try {
          config.env = { ...readEnvFile(config.envFile), ...config.env };
        } catch (e) {
          vscode.window.showErrorMessage(
            localize('VSND2029', "Can't load environment variables from file ({0}).", e.message),
            { modal: true },
          );
        }
      }
    }

    // "attach to process via picker" support
    if (config.request === 'attach' && typeof config.processId === 'string') {
      throw new Error('Resolving process IDs not yet supported'); // todo
    }

    return config.request === 'attach'
      ? { ...nodeAttachConfigDefaults, ...config }
      : { ...nodeLaunchConfigDefaults, ...config };
  }
}

function guessWorkingDirectory(
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
    if (editor) {
      const languageId = editor.document.languageId;
      if (languageId === 'javascript' || isTranspiledLanguage(languageId)) {
        const wf = vscode.workspace.getWorkspaceFolder(editor.document.uri);
        if (wf && wf === folder) {
          program = path.relative(wf.uri.fsPath || '/', editor.document.uri.fsPath || '/');
          if (program && !path.isAbsolute(program)) {
            program = path.join('${workspaceFolder}', program);
          }
        }
      }
      useSourceMaps = isTranspiledLanguage(languageId);
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
      config['preLaunchTask'] = 'tsc: build - tsconfig.json';
    }
    config['outFiles'] = ['${workspaceFolder}/' + dir + '**/*.js'];
  }

  return config;
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

async function resolveNvmVersion(config: Partial<INodeLaunchConfiguration>): Promise<void> {
  let bin: string | undefined = undefined;
  let versionManagerName: string | undefined = undefined;

  // first try the Node Version Switcher 'nvs'
  let nvsHome = process.env['NVS_HOME'];
  if (!nvsHome) {
    // NVS_HOME is not always set. Probe for 'nvs' directory instead
    const nvsDir =
      process.platform === 'win32'
        ? path.join(process.env['LOCALAPPDATA'] || '', 'nvs')
        : path.join(process.env['HOME'] || '', '.nvs');
    if (fs.existsSync(nvsDir)) {
      nvsHome = nvsDir;
    }
  }

  const { nvsFormat, remoteName, semanticVersion, arch } = parseVersionString(
    config.runtimeVersion,
  );

  if (nvsFormat || nvsHome) {
    if (nvsHome) {
      bin = path.join(nvsHome, remoteName, semanticVersion, arch);
      if (process.platform !== 'win32') {
        bin = path.join(bin, 'bin');
      }
      versionManagerName = 'nvs';
    } else {
      throw new Error(
        localize(
          'NVS_HOME.not.found.message',
          "Attribute 'runtimeVersion' requires Node.js version manager 'nvs'.",
        ),
      );
    }
  }

  if (!bin) {
    // now try the Node Version Manager 'nvm'
    if (process.platform === 'win32') {
      const nvmHome = process.env['NVM_HOME'];
      if (!nvmHome) {
        throw new Error(
          localize(
            'NVM_HOME.not.found.message',
            "Attribute 'runtimeVersion' requires Node.js version manager 'nvm-windows' or 'nvs'.",
          ),
        );
      }
      bin = path.join(nvmHome, `v${config.runtimeVersion}`);
      versionManagerName = 'nvm-windows';
    } else {
      // macOS and linux
      let nvmHome = process.env['NVM_DIR'];
      if (!nvmHome) {
        // if NVM_DIR is not set. Probe for '.nvm' directory instead
        const nvmDir = path.join(process.env['HOME'] || '', '.nvm');
        if (fs.existsSync(nvmDir)) {
          nvmHome = nvmDir;
        }
      }
      if (!nvmHome) {
        throw new Error(
          localize(
            'NVM_DIR.not.found.message',
            "Attribute 'runtimeVersion' requires Node.js version manager 'nvm' or 'nvs'.",
          ),
        );
      }
      bin = path.join(nvmHome, 'versions', 'node', `v${config.runtimeVersion}`, 'bin');
      versionManagerName = 'nvm';
    }
  }

  if (fs.existsSync(bin)) {
    if (!config.env) {
      config.env = {};
    }
    if (process.platform === 'win32') {
      config.env['Path'] = `${bin};${process.env['Path']}`;
    } else {
      config.env['PATH'] = `${bin}:${process.env['PATH']}`;
    }
  } else {
    throw new Error(
      localize(
        'runtime.version.not.found.message',
        "Node.js version '{0}' not installed for '{1}'.",
        config.runtimeVersion,
        versionManagerName,
      ),
    );
  }
}

function nvsStandardArchName(arch) {
  switch (arch) {
    case '32':
    case 'x86':
    case 'ia32':
      return 'x86';
    case '64':
    case 'x64':
    case 'amd64':
      return 'x64';
    case 'arm':
      const arm_version = (process.config.variables as any).arm_version;
      return arm_version ? 'armv' + arm_version + 'l' : 'arm';
    default:
      return arch;
  }
}

/**
 * Parses a node version string into remote name, semantic version, and architecture
 * components. Infers some unspecified components based on configuration.
 */
function parseVersionString(versionString) {
  const versionRegex = /^(([\w-]+)\/)?(v?(\d+(\.\d+(\.\d+)?)?))(\/((x86)|(32)|((x)?64)|(arm\w*)|(ppc\w*)))?$/i;

  const match = versionRegex.exec(versionString);
  if (!match) {
    throw new Error('Invalid version string: ' + versionString);
  }

  const nvsFormat = !!(match[2] || match[8]);
  const remoteName = match[2] || 'node';
  const semanticVersion = match[4] || '';
  const arch = nvsStandardArchName(match[8] || process.arch);

  return { nvsFormat, remoteName, semanticVersion, arch };
}

function readEnvFile(file: string): { [key: string]: string } {
  if (!fs.existsSync(file)) {
    return {};
  }

  const buffer = stripBOM(fs.readFileSync(file, 'utf8'));
  const env = {};
  for (const line of buffer.split('\n')) {
    const r = line.match(/^\s*([\w\.\-]+)\s*=\s*(.*)?\s*$/);
    if (!r) {
      continue;
    }

    let [, key, value = ''] = r;
    // .env variables never overwrite existing variables (see #21169)
    if (value.length > 0 && value.charAt(0) === '"' && value.charAt(value.length - 1) === '"') {
      value = value.replace(/\\n/gm, '\n');
    }
    env[key] = value.replace(/(^['"]|['"]$)/g, '');
  }

  return env;
}

function stripBOM(s: string): string {
  if (s && s[0] === '\uFEFF') {
    s = s.substr(1);
  }
  return s;
}
