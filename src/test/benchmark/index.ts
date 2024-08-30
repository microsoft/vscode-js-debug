/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { benchmark, grepMiddleware, PrettyReporter } from '@c4312/matcha';
import { readdirSync } from 'fs';
import 'reflect-metadata';

benchmark({
  reporter: new PrettyReporter(process.stdout),
  middleware: process.argv[2] ? [grepMiddleware(process.argv[2])] : undefined,
  prepare(api) {
    for (
      const file of readdirSync(__dirname).filter(f => f.endsWith('.js') && f !== 'index.js')
    ) {
      api.suite(file, () => require(`./${file}`).default(api));
    }
  },
})
  .then(() => process.exit(0))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
