import { BreakpointWizard } from './breakpointWizard';
import { InternalFileBreakpointsWizard } from './implementation/internalFileBreakpointsWizard';
import { PromiseOrNot } from '../../testUtils';
import { wrapWithMethodLogger } from '../../core-v2/chrome/logging/methodsCalledLogger';
import { PauseOnHitCount } from '../../core-v2/chrome/internal/breakpoints/bpActionWhenHit';

export interface IBreakpointOptions {
    text: string;
    boundText?: string;
}

export interface IHitCountBreakpointOptions extends IBreakpointOptions {
    hitCountCondition: string;
}

export interface IUnverifiedBreakpointOptions {
    text: string;
    unverifiedReason: string;
}

export interface IUnverifiedHitCountBreakpointOptions extends IUnverifiedBreakpointOptions {
    hitCountCondition: string;
}

export class FileBreakpointsWizard {
    public constructor(private readonly _internal: InternalFileBreakpointsWizard) { }

    public async breakpoint(options: IBreakpointOptions): Promise<BreakpointWizard> {
        const wrappedBreakpoint = wrapWithMethodLogger(await this._internal.breakpoint({
            text: options.text,
            boundText: options.boundText,
            name: `BP @ ${options.text}`
        }));

        return wrappedBreakpoint.setThenWaitForVerifiedThenValidate();
    }

    public async hitCountBreakpoint(options: IHitCountBreakpointOptions): Promise<BreakpointWizard> {
        return (await (await this.unsetHitCountBreakpoint(options)).setThenWaitForVerifiedThenValidate());
    }

    public async unverifiedHitCountBreakpoint(options: IUnverifiedHitCountBreakpointOptions): Promise<BreakpointWizard> {
        return (await (await this.unsetHitCountBreakpoint(options)).setWithoutVerifying()).assertIsNotVerified(options.unverifiedReason);
    }

    public async unsetHitCountBreakpoint(options: IHitCountBreakpointOptions): Promise<BreakpointWizard> {
        return wrapWithMethodLogger(await this._internal.breakpoint({
            text: options.text,
            boundText: options.boundText,
            actionWhenHit: new PauseOnHitCount(options.hitCountCondition),
            name: `BP @ ${options.text}`
        }));
    }

    public batch<T>(batchAction: (fileBreakpointsWizard: FileBreakpointsWizard) => PromiseOrNot<T>): Promise<T> {
        return this._internal.batch(batchAction);
    }

    public toString(): string {
        return `Breakpoints at ${this._internal.filePath}`;
    }
}
