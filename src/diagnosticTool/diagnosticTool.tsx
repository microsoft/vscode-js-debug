/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { ComponentType, FunctionComponent, h, render } from 'preact';
import { useState } from 'preact/hooks';
import { IDiagnosticDump } from '../adapter/diagnosics';
import { Intro } from './intro';
import { DumpContext } from './useDump';

require('../../../src/diagnosticTool/diagnosticTool.css');

declare const DUMP: IDiagnosticDump | undefined;

const App: FunctionComponent<{ dump: IDiagnosticDump }> = ({ dump }) => {
  const [Component, setComponent] = useState<ComponentType<{}> | undefined>(undefined);

  return (
    <DumpContext.Provider value={dump}>
      {Component ? <Component /> : <Intro onPick={cmp => setComponent(() => cmp)} />}
    </DumpContext.Provider>
  );
};

if (typeof DUMP !== 'undefined') {
  render(<App dump={DUMP} />, document.body);
} else {
  fetch(document.location.search.slice(1))
    .then(res => res.json())
    .then(dump => render(<App dump={dump} />, document.body));
}
