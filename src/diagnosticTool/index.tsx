/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { ComponentType, FunctionComponent, h, render } from 'preact';
import { useState } from 'preact/hooks';
import { IDiagnosticDump } from '../adapter/diagnosics';
import { Intro } from './intro';

require('../../../src/diagnosticTool/index.css');

declare const DUMP: IDiagnosticDump | undefined;

const App: FunctionComponent<{ dump: IDiagnosticDump }> = ({ dump }) => {
  const [Component, setComponent] = useState<ComponentType<{ dump: IDiagnosticDump }> | undefined>(
    undefined,
  );

  return Component ? <Component dump={dump} /> : <Intro onPick={setComponent} />;
};

if (typeof DUMP !== 'undefined') {
  render(<App dump={DUMP} />, document.body);
} else {
  fetch(document.location.search.slice(1))
    .then(res => res.json())
    .then(dump => render(<App dump={dump} />, document.body));
}
