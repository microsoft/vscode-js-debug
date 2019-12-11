/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { SubprocessMessageFilter } from '../../targets/node/subprocessProgramLauncher';
import { expect } from 'chai';

describe('node subprocess', () => {
  describe('message filter', () => {
    it('buffers and dumps empty', () => {
      const f = new SubprocessMessageFilter(5);
      expect(f.dump()).to.equal('');
    });

    it('buffers and dumps messages below cutoff', () => {
      const f = new SubprocessMessageFilter(5);
      expect(f.test('z')).to.be.true;
      expect(f.test('Debugger attached')).to.be.true;
      expect(f.test('a')).to.be.false;
      expect(f.test('b')).to.be.false;
      expect(f.test('c')).to.be.false;
      expect(f.dump()).to.equal('abc');
    });

    it('buffers and dumps messages above cutoff', () => {
      const f = new SubprocessMessageFilter(5);
      expect(f.test('Debugger attached')).to.be.true;
      expect(f.test('a')).to.be.false;
      expect(f.test('b')).to.be.false;
      expect(f.test('c')).to.be.false;
      expect(f.test('d')).to.be.false;
      expect(f.test('e')).to.be.false;
      expect(f.test('f')).to.be.false;
      expect(f.dump()).to.equal(
        "--- Truncated to last 5 messages, set outputCapture to 'all' to see more ---\r\nbcdef",
      );
    });
  });
});
