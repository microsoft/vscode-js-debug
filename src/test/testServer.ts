/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as express from 'express';
import * as path from 'path';

const app = express();
const webRoot = path.join(__dirname, '..', '..', 'testWorkspace', 'web');
app.use('/', express.static(webRoot));
app.listen(8001, () => {
  process.send!('ready');
});
