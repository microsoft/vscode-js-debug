/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { ComponentType, FunctionComponent, h } from 'preact';
import { IDiagnosticDump } from '../adapter/diagnosics';
import { SourceExplorer } from './sourceExplorer';

export const Intro: FunctionComponent<{
  onPick(cmp: ComponentType<{ dump: IDiagnosticDump }>): void;
}> = ({ onPick }) => (
  <div className="intro">
    <header>Debug Doctor</header>
    <p>What are you trying to find out?</p>
    <ul>
      <li>
        <a role="button" href="">
          Why my breakpoints don&apos;t bind
        </a>
      </li>
      <li>
        <a role="button" onClick={() => onPick(SourceExplorer)}>
          What scripts and sourcemaps are loaded
        </a>
      </li>
      <li>
        <a href="https://github.com/microsoft/vscode-js-debug/issues/new/choose">
          Something else...
        </a>
      </li>
    </ul>
  </div>
);
