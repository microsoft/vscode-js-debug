/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { Fragment, FunctionComponent, h, render } from 'preact';
import { IDiagnosticDump } from '../adapter/diagnosics';
import { BreakpointHelper } from './breakpointHelper';
import { Experience, Intro } from './intro';
import { SourceExplorer } from './sourceExplorer';
import { DumpContext } from './useDump';
import { usePersistedState } from './usePersistentState';

import './diagnosticTool.css';

declare const DUMP: IDiagnosticDump | undefined;

const App: FunctionComponent<{ dump: IDiagnosticDump }> = ({ dump }) => {
  const [experience, setExperience] = usePersistedState<Experience>(
    'experience',
    Experience.Intro,
  );

  return (
    <DumpContext.Provider value={dump}>
      {experience === Experience.Intro ? <Intro onPick={setExperience} /> : (
        <Fragment>
          <a role='button' onClick={() => setExperience(Experience.Intro)} className='back'>
            &larr; Back
          </a>
          {experience === Experience.BreakpointHelper ? <BreakpointHelper /> : <SourceExplorer />}
        </Fragment>
      )}
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
