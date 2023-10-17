/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import { delay, getDeferred } from '../../common/promiseUtil';
import { ReservationQueue } from './reservationQueue';

describe('ReservationQueue', () => {
  let sunk: number[][];
  let queue: ReservationQueue<number>;

  beforeEach(() => {
    sunk = [];
    queue = new ReservationQueue(items => {
      sunk.push(items);
      if (items.includes(-1)) {
        queue.dispose();
      }
    });
  });

  it('enqueues sync', () => {
    queue.enqueue(1);
    queue.enqueue(2);
    queue.enqueue(3);
    expect(sunk).to.deep.equal([[1], [2], [3]]);
  });

  it('enqueues async with order', async () => {
    const gate1 = getDeferred<void>();
    const gate2 = getDeferred<void>();

    queue.enqueue(gate2.promise.then(() => 1));
    queue.enqueue(
      delay(1).then(() => {
        gate1.resolve();
        return 2;
      }),
    );
    queue.enqueue(
      gate1.promise.then(() => {
        gate2.resolve();
        return 3;
      }),
    );
    await delay(10);
    expect(sunk).to.deep.equal([[1, 2, 3]]);
  });

  it('bulks after async resolution', async () => {
    queue.enqueue(1);
    queue.enqueue(delay(6).then(() => 2));
    queue.enqueue(delay(2).then(() => 3));
    queue.enqueue(4);
    queue.enqueue(delay(4).then(() => 5));
    queue.enqueue(delay(8).then(() => 6));
    await delay(10);
    expect(sunk.length).to.be.lessThanOrEqual(3, JSON.stringify(sunk));
    expect(sunk.flat()).to.deep.equal([1, 2, 3, 4, 5, 6]);
  });

  it('stops when disposed', async () => {
    queue.enqueue(delay(2).then(() => 1));
    queue.enqueue(delay(4).then(() => -1));
    queue.enqueue(delay(6).then(() => 3));
    await delay(4);
    expect(sunk).to.deep.equal([[1], [-1]]);
  });
});
