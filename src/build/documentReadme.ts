/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import execa from 'execa';
import { promises as fs } from 'fs';
import { marked } from 'marked';
import strings from '../../package.nls.json';
import { getPreferredOrDebugType } from '../common/contributionUtils';
import { debuggers, DescribedAttribute } from './generate-contributions.js';

(async () => {
  let out = `# Options\n\n`;
  for (const dbg of debuggers) {
    out += `### ${getPreferredOrDebugType(dbg.type)}: ${dbg.request}\n\n`;
    out += `<details>`;

    const entries = Object.entries(dbg.configurationAttributes).sort(([a], [b]) =>
      a.localeCompare(b)
    );
    for (const [key, value] of entries as Iterable<[string, DescribedAttribute<unknown>]>) {
      const descriptionKeyRaw = 'markdownDescription' in value
        ? value.markdownDescription
        : value.description;
      if (!descriptionKeyRaw) {
        continue;
      }

      const descriptionKey = descriptionKeyRaw.slice(1, -1);
      const description = strings[descriptionKey].replace(/\n/g, '<br>');
      if (!description) {
        continue;
      }

      const defaultValue = (dbg.defaults as unknown as { [key: string]: unknown })[key];
      const docDefault = value.docDefault ?? JSON.stringify(defaultValue, null, 2) ?? 'undefined';
      out += `<h4>${key}</h4>`;
      out += `${marked(description)}`;
      out += `<h5>Default value:</h4>`;
      out += `<pre><code>${docDefault}</pre></code>`;
    }
    out += `</details>\n\n`;
  }

  await fs.writeFile('OPTIONS.md', out);
  await execa('node_modules/.bin/dprint', ['fmt', 'OPTIONS.md']);
})().catch(console.error);
