/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { FunctionComponent, h } from 'preact';

export const enum Experience {
  Intro,
  BreakpointHelper,
  SourceExplorer,
}

export const Intro: FunctionComponent<{
  onPick(exp: Experience): void;
}> = ({ onPick }) => (
  <div className='intro'>
    <div>
      <header>Debug Doctor</header>
      <div className='intro-content'>
        <p>What are you trying to find out?</p>
        <ul>
          <li>
            <a role='button' onClick={() => onPick(Experience.BreakpointHelper)}>
              Why my breakpoints don&apos;t bind
            </a>
          </li>
          <li>
            <a role='button' onClick={() => onPick(Experience.SourceExplorer)}>
              What scripts and sourcemaps are loaded
            </a>
          </li>
          <li>
            <a href='https://github.com/microsoft/vscode-js-debug/issues/new/choose'>
              Something else...
            </a>
          </li>
        </ul>
      </div>
    </div>
  </div>
);
