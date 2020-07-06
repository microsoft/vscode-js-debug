/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { promises as fs } from 'fs';
import { debuggers } from './generate-contributions';
import { format } from 'prettier';
import { prettier as prettierOpts } from '../../package.json';
import strings from './strings';
import marked from 'marked';

(async () => {
  let out = `# Options\n\n`;
  for (const dbg of debuggers) {
    out += `### ${dbg.type}: ${dbg.request}\n\n`;
    out += `<details>`;

    const entries = Object.entries(dbg.configurationAttributes).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    for (const [key, value] of entries) {
      if (!value.description && !value.markdownDescription) {
        continue;
      }

      const descriptionKey = (value.description ?? value.markdownDescription)?.slice(1, -1);
      const description = strings[descriptionKey as keyof typeof strings].replace(/\n/g, '<br>');
      if (!description) {
        continue;
      }

      const defaultValue = ((dbg.defaults as unknown) as { [key: string]: unknown })[key];
      out += `<h4>${key}</h4>`;
      out += `${marked(description)}`;
      out += `<h5>Default value:</h4>`;
      out += `<pre><code>${JSON.stringify(defaultValue, null, 2) ?? 'undefined'}</pre></code>`;
    }
    out += `</details>\n\n`;
  }

  await fs.writeFile(
    'OPTIONS.md',
    format(out, {
      parser: 'markdown',
      ...prettierOpts,
    }),
  );
})().catch(console.error);
