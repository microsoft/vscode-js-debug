// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { BreakpointWizard } from '../breakpointWizard';
import { IBreakpointsBatchingStrategy, InternalFileBreakpointsWizard, CurrentBreakpointsMapping, BreakpointsUpdate, BreakpointStatusChangedWithId } from './internalFileBreakpointsWizard';
import { BreakpointsAssertions } from './breakpointsAssertions';
import { BreakpointsWizard, IVerificationsAndAction } from '../breakpointsWizard';
import { ValidatedMap } from '../../../core-v2/chrome/collections/validatedMap';

export class PerformChangesImmediatelyState implements IBreakpointsBatchingStrategy {
    private readonly _idToBreakpoint = new ValidatedMap<number, BreakpointWizard>();
    private readonly _breakpointsAssertions = new BreakpointsAssertions(this._internal, this.currentBreakpointsMapping);

    public constructor(
        private readonly _breakpointsWizard: BreakpointsWizard,
        private readonly _internal: InternalFileBreakpointsWizard,
        public readonly currentBreakpointsMapping: CurrentBreakpointsMapping) {
        this.currentBreakpointsMapping.forEach((vsCodeStatus, breakpoint) => {
            this._idToBreakpoint.set(vsCodeStatus.id, breakpoint);
        });
    }

    public async set(breakpointWizard: BreakpointWizard): Promise<void> {
        if (this.currentBreakpointsMapping.has(breakpointWizard)) {
            throw new Error(`Can't set the breakpoint: ${breakpointWizard} because it's already set`);
        }

        await this._internal.sendBreakpointsToClient(new BreakpointsUpdate([breakpointWizard], [], this.currentBreakpoints()));
    }

    public async unset(breakpointWizard: BreakpointWizard): Promise<void> {
        if (!this.currentBreakpointsMapping.has(breakpointWizard)) {
            throw new Error(`Can't unset the breakpoint: ${breakpointWizard} because it is not set`);
        }

        const remainingBreakpoints = this.currentBreakpoints().filter(bp => bp !== breakpointWizard);
        await this._internal.sendBreakpointsToClient(new BreakpointsUpdate([], [breakpointWizard], remainingBreakpoints));
    }

    public onBreakpointStatusChange(breakpointStatusChanged: BreakpointStatusChangedWithId): void {
        const breakpoint = this._idToBreakpoint.get(breakpointStatusChanged.breakpoint.id);
        this.currentBreakpointsMapping.setAndReplaceIfExist(breakpoint, breakpointStatusChanged.breakpoint);
    }

    public assertIsVerified(breakpoint: BreakpointWizard): void {
        this._breakpointsAssertions.assertIsVerified(breakpoint);
    }

    public assertIsNotVerified(breakpoint: BreakpointWizard, unverifiedReason: string): void {
        this._breakpointsAssertions.assertIsNotVerified(breakpoint, unverifiedReason);
    }

    public async waitUntilVerified(breakpoint: BreakpointWizard): Promise<void> {
        await this._breakpointsAssertions.waitUntilVerified(breakpoint);
    }

    public async assertIsHitThenResumeWhen(breakpoint: BreakpointWizard, lastActionToMakeBreakpointHit: () => Promise<void>, verifications: IVerificationsAndAction): Promise<void> {
        await this._breakpointsWizard.assertIsHitThenResumeWhen([breakpoint], lastActionToMakeBreakpointHit, verifications);
    }

    public async assertIsHitThenResume(breakpoint: BreakpointWizard, verifications: IVerificationsAndAction): Promise<void> {
        await this._breakpointsWizard.assertIsHitThenResume(breakpoint, verifications);
    }

    private currentBreakpoints(): BreakpointWizard[] {
        return Array.from(this.currentBreakpointsMapping.keys());
    }
}
