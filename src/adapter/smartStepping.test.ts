/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import { createStubInstance, stub } from 'sinon';
import { Logger } from '../common/logging/logger';
import { upcastPartial } from '../common/objUtils';
import { nodeLaunchConfigDefaults } from '../configuration';
import { IPausedDetails, StepDirection } from './pause';
import { SmartStepper } from './smartStepping';
import { Source, SourceLocationProvider } from './source';
import { IPreferredUiLocation, UnmappedReason } from './sourceContainer';
import { StackFrame, StackTrace } from './stackTrace';

describe('SmartStepper', () => {
  for (const kind of ['skipped', 'unmapped'] as const) {
    describe(`${kind} frame`, () => {
      let stepper: SmartStepper;
      let paused: IPausedDetails;

      beforeEach(() => {
        stepper = new SmartStepper({ ...nodeLaunchConfigDefaults, smartStep: true }, Logger.null);
        const source = createStubInstance(Source);
        source.blackboxed.returns(kind === 'skipped');
        if (kind === 'unmapped') {
          source.sourceMap = upcastPartial<SourceLocationProvider>({});
        }

        const frame = Object.assign(createStubInstance(StackFrame), {
          uiLocation: stub().resolves(upcastPartial<IPreferredUiLocation>({
            source,
            isMapped: false,
            unmappedReason: UnmappedReason.MapPositionMissing,
          })),
        });
        const stackTrace = createStubInstance(StackTrace);
        stackTrace.loadFrames.resolves([frame]);
        paused = upcastPartial<IPausedDetails>({ reason: 'pause', stackTrace });
      });

      it('honors an explicit pause request', async () => {
        expect(await stepper.getSmartStepDirection(paused, { reason: 'pause' })).to.be.undefined;
      });

      it('still smart steps a pause without explicit pause intent', async () => {
        expect(await stepper.getSmartStepDirection(paused)).to.equal(StepDirection.In);
      });

      for (const direction of [StepDirection.In, StepDirection.Over, StepDirection.Out]) {
        it(`preserves step direction ${direction}`, async () => {
          expect(await stepper.getSmartStepDirection(paused, { reason: 'step', direction }))
            .to.equal(direction);
        });
      }

      for (const reason of ['breakpoint', 'exception', 'entry'] as const) {
        it(`preserves ${reason} stops`, async () => {
          expect(await stepper.getSmartStepDirection({ ...paused, reason })).to.be.undefined;
        });
      }

      it('resets the automatic stepping limit when explicitly paused', async () => {
        for (let i = 0; i < 258; i++) {
          await stepper.getSmartStepDirection(paused);
        }
        expect(await stepper.getSmartStepDirection(paused)).to.equal(StepDirection.Out);

        await stepper.getSmartStepDirection(paused, { reason: 'pause' });

        expect(
          await stepper.getSmartStepDirection(paused, {
            reason: 'step',
            direction: StepDirection.In,
          }),
        ).to.equal(StepDirection.In);
      });
    });
  }
});
