/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import { EventEmitter } from './events';

describe('EventEmitter', () => {
  it('keeps delivering events after a listener throws', () => {
    const emitter = new EventEmitter<string>();
    const delivered: string[] = [];

    emitter.event(event => {
      if (event === 'throws') {
        throw new Error('listener error');
      }

      delivered.push(event);
    });

    emitter.fire('before');
    expect(() => emitter.fire('throws')).to.throw('listener error');
    emitter.fire('after');

    expect(delivered).to.deep.equal(['before', 'after']);
  });
});
