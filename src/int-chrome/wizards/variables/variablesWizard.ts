// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as _ from 'lodash';
import { PromiseOrNot } from '../../testUtils';
import { StackFrameWizard } from './stackFrameWizard';
import { VariablesVerifier } from './variablesVerifier';
import { ValidatedMap } from '../../core-v2/chrome/collections/validatedMap';
import { trimWhitespaceAndComments } from '../breakpoints/implementation/printedTestInputl';
import { expect } from 'chai';
import { printVariables } from './variablesPrinting';
import { ExtendedDebugClient } from '../../testSupport/debugClient';

export interface VariablePrintedProperties {
    value: string;
    type: string;
}

export interface ManyVariablePrintedProperties {
    [variableName: string]: VariablePrintedProperties;
}

export interface ManyVariablesValues {
    [variableName: string]: unknown;
}

export type ManyVariablesPropertiesPrinted = string;  // `${variable.name} = ${variable.value} ${(variable.type)}\n`

export type IScopeExpectedVariables = ManyVariablesPropertiesPrinted | ManyVariablesValues;

export interface IExpectedVariables {
    script?: IScopeExpectedVariables;
    local?: IScopeExpectedVariables;
    global?: IScopeExpectedVariables;
    catch?: IScopeExpectedVariables;
    block?: IScopeExpectedVariables;
    closure?: IScopeExpectedVariables;
    eval?: IScopeExpectedVariables;
    with?: IScopeExpectedVariables;
    module?: IScopeExpectedVariables;

    local_contains?: ManyVariablesValues;
}

export type VariablesScopeName = keyof IExpectedVariables;
export type VerificationModifier = 'contains' | '';

export class VariablesWizard {
    public constructor(private readonly _client: ExtendedDebugClient) { }

    /** Verify that the global variables have the expected values, ignoring the variables in <namesOfGlobalsToIgnore> */
    public async assertNewGlobalVariariablesAre(actionThatAddsNewVariables: () => PromiseOrNot<void>, expectedGlobals: ManyVariablesPropertiesPrinted): Promise<void> {
        // Store pre-existing global variables' names
        const namesOfGlobalsToIgnore = await (await this.topStackFrameHelper()).globalVariableNames();

        // Perform an action that adds new global variables
        await actionThatAddsNewVariables();

        const globalsOnFrame = await (await this.topStackFrameHelper()).variablesOfScope('global');
        const nonIgnoredGlobals = globalsOnFrame.filter(global => !namesOfGlobalsToIgnore.has(global.name));
        const expectedGlobalsTrimmed = trimWhitespaceAndComments(expectedGlobals);
        expect(printVariables(nonIgnoredGlobals)).to.equal(expectedGlobalsTrimmed);
    }

    /**
     * Verify that the stackFrame contains some variables with a specific value
     */
    public async assertTopFrameVariablesAre(verifications: IExpectedVariables): Promise<void> {
        await this.assertStackFrameVariablesAre(await this.topStackFrameHelper(), verifications);
    }

    public async assertStackFrameVariablesAre(stackFrame: StackFrameWizard, verifications: IExpectedVariables) {
        const scopesWithModifiers = Object.keys(verifications);
        const scopesWithoutModifiers = scopesWithModifiers.map(s => this.splitIntoScopeNameAndModifier(s)[0]);
        const zippedScopes = _.zip(scopesWithoutModifiers, scopesWithModifiers) as [keyof IExpectedVariables, keyof IExpectedVariables][];
        const withoutModifiersToWith = new ValidatedMap<keyof IExpectedVariables, keyof IExpectedVariables>(zippedScopes);
        const manyScopes = await (stackFrame).variablesOfScopes(scopesWithoutModifiers);
        for (const scope of manyScopes) {
            const scopeNameWithModifier = withoutModifiersToWith.get(scope.scopeName)!;
            const [, modifier] = this.splitIntoScopeNameAndModifier(scopeNameWithModifier);
            switch (modifier) {
                case '':
                    this.verificator.assertVariablesAre(scope.variables, verifications[scopeNameWithModifier] as IScopeExpectedVariables);
                    break;
                case 'contains':
                    this.verificator.assertVariablesValuesContain(scope.variables, <ManyVariablesValues>verifications[scopeNameWithModifier]!);
                    break;
                default:
                    throw new Error(`Unknown modified used for variables verification: ${modifier} in ${scopeNameWithModifier}`);
            }
        }
    }

    public async set(variableName: string, newValue: string): Promise<void> {
        const stackFrame = await this.topStackFrameHelper();
        const { scope, variable } = await stackFrame.variable(variableName);
        const response = await this._client.setVariableRequest({ variablesReference: scope.variablesReference, name: variable.name, value: newValue });
        expect(response.success).to.equal(true);
    }

    private splitIntoScopeNameAndModifier(modifiedScopeName: keyof IExpectedVariables): [VariablesScopeName, VerificationModifier] {
        const components = modifiedScopeName.split('_');
        if (components.length > 2) {
            throw new Error(`Invalid modified scope name: ${modifiedScopeName}`);
        }

        return [<VariablesScopeName>components[0], <VerificationModifier>_.defaultTo(components[1], '')];
    }

    private get verificator(): VariablesVerifier {
        return new VariablesVerifier();
    }

    private async topStackFrameHelper(): Promise<StackFrameWizard> {
        return await StackFrameWizard.topStackFrame(this._client);
    }
}
