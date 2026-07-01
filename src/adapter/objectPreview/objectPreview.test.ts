/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import { formatMessage } from '../messageFormat';
import { messageFormatters } from './index';

describe('objectPreview', () => {
  describe('%j format specifier', () => {
    const format = (fmt: string, ...args: object[]) =>
      formatMessage(fmt, args as never, messageFormatters).result;

    it('formats a simple object as JSON', () => {
      expect(
        format('%j', {
          type: 'object',
          subtype: undefined,
          className: 'Object',
          description: 'Object',
          preview: {
            type: 'object',
            description: 'Object',
            overflow: false,
            properties: [{ name: 'host', type: 'string', value: 'localhost' }],
          },
        }),
      ).to.equal('{"host":"localhost"}');
    });

    it('formats a nested object as JSON', () => {
      expect(
        format('%j', {
          type: 'object',
          subtype: undefined,
          className: 'Object',
          description: 'Object',
          preview: {
            type: 'object',
            description: 'Object',
            overflow: false,
            properties: [
              {
                name: 'a',
                type: 'object',
                subtype: undefined,
                valuePreview: {
                  type: 'object',
                  description: 'Object',
                  overflow: false,
                  properties: [{ name: 'b', type: 'number', value: '1' }],
                },
              },
            ],
          },
        }),
      ).to.equal('{"a":{"b":1}}');
    });

    it('formats an array as JSON', () => {
      expect(
        format('%j', {
          type: 'object',
          subtype: 'array',
          className: 'Array',
          description: 'Array(3)',
          preview: {
            type: 'object',
            subtype: 'array',
            description: 'Array(3)',
            overflow: false,
            properties: [
              { name: '0', type: 'number', value: '1' },
              { name: '1', type: 'number', value: '2' },
              { name: '2', type: 'number', value: '3' },
            ],
          },
        }),
      ).to.equal('[1,2,3]');
    });

    it('formats null as JSON', () => {
      expect(format('%j', { type: 'object', subtype: 'null' })).to.equal('null');
    });

    it('formats a string as JSON', () => {
      expect(
        format('%j', { type: 'string', value: 'hello', subtype: undefined }),
      ).to.equal('"hello"');
    });

    it('formats a number as JSON', () => {
      expect(
        format('%j', { type: 'number', value: 42, description: '42', subtype: undefined }),
      ).to.equal('42');
    });

    it('formats NaN as null in JSON', () => {
      expect(
        format('%j', {
          type: 'number',
          unserializableValue: 'NaN',
          description: 'NaN',
          subtype: undefined,
        }),
      ).to.equal('null');
    });

    it('formats a boolean as JSON', () => {
      expect(
        format('%j', { type: 'boolean', value: true, description: 'true', subtype: undefined }),
      ).to.equal('true');
    });

    it('formats undefined as the string "undefined"', () => {
      expect(format('%j', { type: 'undefined', subtype: undefined })).to.equal('undefined');
    });

    it('formats a function as the string "undefined"', () => {
      expect(
        format('%j', {
          type: 'function',
          subtype: undefined,
          description: 'function() {}',
        }),
      ).to.equal('undefined');
    });

    it('handles mixed specifiers correctly', () => {
      expect(
        format(
          '%s: %s %j',
          { type: 'string', value: 'id', subtype: undefined },
          { type: 'string', value: 'Request headers', subtype: undefined },
          {
            type: 'object',
            subtype: undefined,
            className: 'Object',
            description: 'Object',
            preview: {
              type: 'object',
              description: 'Object',
              overflow: false,
              properties: [{ name: 'host', type: 'string', value: 'localhost' }],
            },
          },
        ),
      ).to.equal('id: Request headers {"host":"localhost"}');
    });

    it('omits undefined properties from JSON object', () => {
      expect(
        format('%j', {
          type: 'object',
          subtype: undefined,
          className: 'Object',
          description: 'Object',
          preview: {
            type: 'object',
            description: 'Object',
            overflow: false,
            properties: [
              { name: 'a', type: 'string', value: 'hello' },
              { name: 'fn', type: 'function', value: 'function()' },
              { name: 'undef', type: 'undefined' },
            ],
          },
        }),
      ).to.equal('{"a":"hello"}');
    });
  });
});
