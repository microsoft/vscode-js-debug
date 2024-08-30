/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { FunctionComponent, h } from 'preact';

export const DecisionButtons = <T extends string>(
  options: T[],
): FunctionComponent<{
  value: T | undefined;
  onChange(option: T): void;
}> =>
  function DecisionButtons({ value, onChange }) {
    return (
      <div className='decision-buttons'>
        {options.map(b => (
          <button
            key={b}
            onClick={() => onChange(b)}
            className={value === b ? 'active' : ''}
          >
            {b}
          </button>
        ))}
      </div>
    );
  };
