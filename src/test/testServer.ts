/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import express from 'express';
import * as path from 'path';

const port = +process.argv[2];
const app = express();
const webRoot = path.join(__dirname, '..', '..', '..', 'testWorkspace', 'web');
app.get('/cookies/home', (req, res) => {
  res.header('Set-Cookie', 'authed=true');
  res.sendFile(path.join(webRoot, 'browserify/pause.html'));
});

app.get('/unique-refresh', (req, res) => {
  res.send(`<script src="hello.js?v=${req.query.v}"></script>`);
});

app.get('/redirect-test/home', (req, res) => {
  res.header('Set-Cookie', 'authed=true');
  res.sendFile(path.join(webRoot, 'browserify/pause.html'));
});

app.get('/redirect-test/:resource', (req, res) => {
  if (req.params.resource.endsWith('.map')) {
    res.redirect(`/browserify/${req.params.resource}`);
  } else {
    res.sendFile(path.join(webRoot, `browserify/${req.params.resource}`));
  }
});

app.use(
  '/cookies',
  (req, res, next) => {
    if (!req.headers.cookie?.includes('authed=true')) {
      res.status(403).send('access denied');
    } else {
      next();
    }
  },
  express.static(path.join(webRoot, 'browserify')),
);

app.get('/redirect-to-greet', (_req, res) => res.redirect('/greet'));

app.get('/greet', (_req, res) => res.send('Hello world!'));

app.use('/', express.static(path.join(webRoot)));

app.listen(port, () => {
  process.send!('ready');
});
