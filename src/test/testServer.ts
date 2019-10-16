// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import express from 'express';
import * as path from 'path';

const port = +process.argv[2];
const app = express();
const webRoot = path.join(__dirname, '..', '..', '..', 'testWorkspace', 'web');
app.use('/', express.static(webRoot));
app.listen(port, () => {
  process.send!('ready');
});
