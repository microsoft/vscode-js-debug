/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import { loadProjectLabels } from '../labels';
import { expect } from 'chai';
import * as path from 'path';

suite('Test framework tests', () => {
  test('Should correctly find breakpoint labels in test source files', async () => {
    const labels = await loadProjectLabels('./testdata');
    const worldLabel = labels.get('WorldLabel');

    expect(worldLabel.path).to.eql(path.join('testdata', 'labelTest.ts'));
    expect(worldLabel.line).to.eql(9);
  });

  test('Should correctly find block comment breakpoint labels in test source files', async () => {
    const labels = await loadProjectLabels('./testdata');
    const blockLabel = labels.get('blockLabel');

    expect(blockLabel.path).to.eql(path.join('testdata', 'labelTest.ts'));
    expect(blockLabel.line).to.eql(10);
  });
});
