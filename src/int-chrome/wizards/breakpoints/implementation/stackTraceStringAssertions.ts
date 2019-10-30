// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as assert from 'assert';
import { DebugProtocol } from 'vscode-debugprotocol';
import { expect } from 'chai';
import { BreakpointWizard } from '../breakpointWizard';
import { trimWhitespaceAndComments } from './printedTestInputl';
import { findLineNumber } from '../../../utils/findPositionOfTextInFile';

export class StackTraceStringAssertions {
    public constructor(
        private readonly _breakpoint: BreakpointWizard) { }

    public  assertResponseMatches(stackTraceFrames: DebugProtocol.StackFrame[], expectedString: string) {

        stackTraceFrames.forEach(frame => {
            // Warning: We don't currently validate frame.source.path
            expect(frame.source).not.to.equal(undefined);
            const expectedSourceNameAndLine = ` [${frame.source!.name}] Line ${frame.line}`;
            (expect(frame.name, 'Expected the formatted name to match the source name and line supplied as individual attributes').to as any).endsWith(expectedSourceNameAndLine); // TODO@rob
        });


        const formattedExpectedStackTrace = trimWhitespaceAndComments(expectedString);
        this.applyIgnores(formattedExpectedStackTrace, stackTraceFrames);
        const actualStackTrace = this.extractStackTrace(stackTraceFrames);
        assert.equal(actualStackTrace, formattedExpectedStackTrace, `Expected the stack trace when hitting ${this._breakpoint} to be:\n${formattedExpectedStackTrace}\nyet it is:\n${actualStackTrace}`);
    }

    private applyIgnores(formattedExpectedStackTrace: string, stackTrace: DebugProtocol.StackFrame[]): void {
        const ignoreFunctionNameText = '<__IGNORE_FUNCTION_NAME__>';
        const lineWithIgnoreIndex = formattedExpectedStackTrace.indexOf(ignoreFunctionNameText);
        if (lineWithIgnoreIndex >= 0) {
            const ignoreFunctionName = findLineNumber(formattedExpectedStackTrace, lineWithIgnoreIndex);
            expect(stackTrace.length).to.be.greaterThan(ignoreFunctionName);
            const ignoredFrame = stackTrace[ignoreFunctionName];
            ignoredFrame.name = `${ignoreFunctionNameText} [${ignoredFrame.source!.name}] Line ${ignoredFrame.line}`;
        }
    }

    private extractStackTrace(stackTrace: DebugProtocol.StackFrame[]): string {
        return stackTrace.map(f => this.printStackTraceFrame(f)).join('\n');
    }

    private printStackTraceFrame(frame: DebugProtocol.StackFrame): string {
        let frameName = frame.name;
        return `${frameName}:${frame.column}${frame.presentationHint && frame.presentationHint !== 'normal' ? ` (${frame.presentationHint})` : ''}`;
    }
}