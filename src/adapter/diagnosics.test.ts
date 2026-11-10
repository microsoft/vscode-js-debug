/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import { chromeLaunchConfigDefaults } from '../configuration';
import { createDiagnosticHtml, IDiagnosticDump } from './diagnosics';

describe('Diagnostics', () => {
  it('safely serializes diagnostic data into HTML', () => {
    const payload = '</ScRiPt><script>globalThis.injected = true</script>';
    const dump: IDiagnosticDump = {
      breakpoints: [],
      sources: [],
      config: {
        ...chromeLaunchConfigDefaults,
        env: { PAYLOAD: payload },
      },
    };

    const html = createDiagnosticHtml(dump, 'body {}', 'window.rendered = true', 'test-nonce');
    const serializedDump = html.match(
      /<script nonce="test-nonce">window\.DUMP=(.*?)<\/script>/s,
    )?.[1];

    expect(serializedDump).to.be.a('string');
    expect(serializedDump).not.to.include('<');
    expect(JSON.parse(serializedDump!)).to.deep.equal(JSON.parse(JSON.stringify(dump)));
    expect(html.match(/<\/script>/gi)).to.have.length(2);
    expect(html).to.include(
      "script-src 'nonce-test-nonce'; style-src 'nonce-test-nonce';",
    );
  });

  it('escapes JavaScript line separators in diagnostic data', () => {
    const dump: IDiagnosticDump = {
      breakpoints: [],
      sources: [],
      config: {
        ...chromeLaunchConfigDefaults,
        name: 'before\u2028after\u2029',
      },
    };

    const html = createDiagnosticHtml(dump, '', '', 'test-nonce');
    const serializedDump = html.match(
      /<script nonce="test-nonce">window\.DUMP=(.*?)<\/script>/s,
    )?.[1];

    expect(serializedDump).to.include('\\u2028').and.include('\\u2029');
    expect(JSON.parse(serializedDump!)).to.deep.equal(JSON.parse(JSON.stringify(dump)));
  });
});
