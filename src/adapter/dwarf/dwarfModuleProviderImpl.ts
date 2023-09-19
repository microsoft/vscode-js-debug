/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import type * as dwf from '@vscode/dwarf-debugging';
import * as l10n from '@vscode/l10n';
import { inject, injectable } from 'inversify';
import Dap from '../../dap/api';
import { IDapApi } from '../../dap/connection';
import { IDwarfModuleProvider } from './dwarfModuleProvider';

const name = '@vscode/dwarf-debugging';

@injectable()
export class DwarfModuleProvider implements IDwarfModuleProvider {
  private didPrompt = false;

  constructor(@inject(IDapApi) private readonly dap: Dap.Api) {}

  public async load(): Promise<typeof dwf | undefined> {
    try {
      return await import(name);
    } catch {
      return undefined;
    }
  }

  public prompt() {
    if (!this.didPrompt) {
      this.didPrompt = true;
      this.dap.output({
        output: l10n.t(
          'You may install the `{}` module via npm for enhanced WebAssembly debugging',
          name,
        ),
        category: 'console',
      });
    }
  }
}
