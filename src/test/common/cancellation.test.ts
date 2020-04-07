/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as assert from 'assert';
import { expect } from 'chai';
import {
  CancellationTokenSource,
  NeverCancelled,
  timeoutPromise,
  Cancelled,
  TaskCancelledError,
} from '../../common/cancellation';
import { delay } from '../../common/promiseUtil';

describe('CancellationToken', () => {
  it('None', () => {
    expect(NeverCancelled.isCancellationRequested).to.equal(false);
    expect(typeof NeverCancelled.onCancellationRequested).to.equal('function');
  });

  it('cancel before token', function (done) {
    const source = new CancellationTokenSource();
    expect(source.token.isCancellationRequested).to.equal(false);
    source.cancel();

    expect(source.token.isCancellationRequested).to.equal(true);

    source.token.onCancellationRequested(() => {
      assert.ok(true);
      done();
    });
  });

  it('cancel happens only once', () => {
    const source = new CancellationTokenSource();
    expect(source.token.isCancellationRequested).to.equal(false);

    let cancelCount = 0;
    function onCancel() {
      cancelCount += 1;
    }

    source.token.onCancellationRequested(onCancel);

    source.cancel();
    source.cancel();

    expect(cancelCount).to.equal(1);
  });

  it('cancel calls all listeners', () => {
    let count = 0;

    const source = new CancellationTokenSource();
    source.token.onCancellationRequested(() => {
      count += 1;
    });
    source.token.onCancellationRequested(() => {
      count += 1;
    });
    source.token.onCancellationRequested(() => {
      count += 1;
    });

    source.cancel();
    expect(count).to.equal(3);
  });

  it('token stays the same', () => {
    let source = new CancellationTokenSource();
    let token = source.token;
    assert.ok(token === source.token); // doesn't change on get

    source.cancel();
    assert.ok(token === source.token); // doesn't change after cancel

    source.cancel();
    assert.ok(token === source.token); // doesn't change after 2nd cancel

    source = new CancellationTokenSource();
    source.cancel();
    token = source.token;
    assert.ok(token === source.token); // doesn't change on get
  });

  it('dispose calls no listeners', () => {
    let count = 0;

    const source = new CancellationTokenSource();
    source.token.onCancellationRequested(() => {
      count += 1;
    });

    source.dispose();
    source.cancel();
    expect(count).to.equal(0);
  });

  it('dispose calls no listeners (unless told to cancel)', () => {
    let count = 0;

    const source = new CancellationTokenSource();
    source.token.onCancellationRequested(() => {
      count += 1;
    });

    source.dispose(true);
    // source.cancel();
    expect(count).to.equal(1);
  });

  it('parent cancels child', () => {
    const parent = new CancellationTokenSource();
    const child = new CancellationTokenSource(parent.token);

    let count = 0;
    child.token.onCancellationRequested(() => (count += 1));

    parent.cancel();

    expect(count).to.equal(1);
    expect(child.token.isCancellationRequested).to.equal(true);
    expect(parent.token.isCancellationRequested).to.equal(true);
  });

  describe('cancellableRace', () => {
    it('returns the value when no cancellation is requested', async () => {
      const v = await timeoutPromise(Promise.resolve(42), NeverCancelled);
      expect(v).to.equal(42);
    });

    it('throws if cancellation is requested', async () => {
      try {
        await timeoutPromise(Promise.resolve(42), Cancelled);
        throw new Error('expected to throw');
      } catch (e) {
        if (e instanceof TaskCancelledError) {
          expect(e.message).to.equal('Task cancelled');
        } else {
          throw e;
        }
      }
    });

    it('throws if lazy cancellation is requested', async () => {
      try {
        await timeoutPromise(
          delay(1000),
          CancellationTokenSource.withTimeout(3).token,
          'Could not do the thing',
        );
        throw new Error('expected to throw');
      } catch (e) {
        if (e instanceof TaskCancelledError) {
          expect(e.message).to.equal('Could not do the thing');
        } else {
          throw e;
        }
      }
    });
  });
});
