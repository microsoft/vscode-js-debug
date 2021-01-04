/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { promises as fs } from 'fs';
import marked from 'marked';
import { format } from 'prettier';
import { prettier as prettierOpts } from '../../package.json';
import { debuggers, DescribedAttribute } from './generate-contributions';
import strings from './strings';

(async () => {
  let out = `# Options\n\n`;
  for (const dbg of debuggers) {
    out += `### ${dbg.type}: ${dbg.request}\n\n`;
    out += `<details>`;

    const entries = Object.entries(dbg.configurationAttributes).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    for (const [key, value] of entries as Iterable<[string, DescribedAttribute<unknown>]>) {
      const descriptionKeyRaw =
        'markdownDescription' in value ? value.markdownDescription : value.description;
      if (!descriptionKeyRaw) {
        continue;
      }

      const descriptionKey = descriptionKeyRaw.slice(1, -1) as keyof typeof strings;
      const description = strings[descriptionKey].replace(/\n/g, '<br>');
      if (!description) {
        continue;
      }

      const defaultValue = ((dbg.defaults as unknown) as { [key: string]: unknown })[key];
      const docDefault = value.docDefault ?? JSON.stringify(defaultValue, null, 2) ?? 'undefined';
      out += `<h4>${key}</h4>`;
      out += `${marked(description)}`;
      out += `<h5>Default value:</h4>`;
      out += `<pre><code>${docDefault}</pre></code>`;
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
