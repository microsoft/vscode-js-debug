/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { TestP } from '../test';

export function addTests(testRunner) {
  // @ts-ignore unused xit/fit variables.
  const { it, fit, xit, describe, fdescribe, xdescribe } = testRunner;

  async function evaluateAndLog(p: TestP, expressions: string[]) {
    let complete: () => void;
    const result = new Promise(f => complete = f);
    const next = async () => {
      const expression = expressions.shift();
      if (!expression) {
        complete();
      } else {
        p.log(`Evaluating: '${expression}'`);
        await p.dap.evaluate({ expression });
      }
    };

    let chain = Promise.resolve();
    p.dap.on('output', async params => {
      chain = chain.then(async () => {
        await p.logger.logOutput(params);
        p.log(``);
        next();
      });
    });

    next();
    await result;
  }

  describe('format', () => {
    it('format string', async ({ p }: { p: TestP }) => {
      await p.launchAndLoad(`
        <script>
          var array = ["test", "test2"];array.length = 10;
          array.foo = {};
          array[4] = "test4";
        </script>`);
      await evaluateAndLog(p, [
        `console.log(array)`,
        `console.log("%o", array)`,
        `console.log("%O", array)`,
        `console.log("Test for zero \\"%f\\" in formatter", 0)`,
        `console.log("%% self-escape1", "dummy")`,
        `console.log("%%s self-escape2", "dummy")`,
        `console.log("%%ss self-escape3", "dummy")`,
        `console.log("%%s%s%%s self-escape4", "dummy")`,
        `console.log("%%%%% self-escape5", "dummy")`,
        `console.log("%%%s self-escape6", "dummy");`
      ]);
      p.assertLog();
    });

    it('popular types', async ({ p }: { p: TestP }) => {
      await p.launchAndLoad(`
        <script>
          // Populate Globals
          var regex1 = /^url\\(\\s*(?:(?:"(?:[^\\\\\\"]|(?:\\\\[\\da-f]{1,6}\\s?|\\.))*"|'(?:[^\\\\\\']|(?:\\\\[\\da-f]{1,6}\\s?|\\.))*')|(?:[!#$%&*-~\\w]|(?:\\\\[\\da-f]{1,6}\\s?|\\.))*)\\s*\\)/i;
          var regex2 = new RegExp("foo\\\\\\\\bar\\\\sbaz", "i");
          var str = "test";
          var str2 = "test named \\"test\\"";
          var error = new Error;
          var errorWithMessage = new Error("my error message");
          var errorWithMultilineMessage = new Error("my multiline\\nerror message");
          var node = document.getElementById("p");
          var func = function() { return 1; };
          var multilinefunc = function() {
              return 2;
          };
          var num = 1.2e-1;
          var linkify = "http://webkit.org/";
          var valuelessAttribute = document.createAttribute("attr");
          var valuedAttribute = document.createAttribute("attr");
          valuedAttribute.value = "value";
          var existingAttribute = document.getElementById("x").attributes[0];
          var throwingLengthGetter = {get length() { throw "Length called"; }};
          var objectWithNonEnumerables = Object.create({ foo: 1 }, {
              __underscoreNonEnumerableProp: { value: 2, enumerable: false },
              abc: { value: 3, enumerable: false },
              getFoo: { value: function() { return this.foo; } },
              bar: { get: function() { return this.bar; }, set: function(x) { this.bar = x; } }
          });
          objectWithNonEnumerables.enumerableProp = 4;
          objectWithNonEnumerables.__underscoreEnumerableProp__ = 5;
          var negZero = 1 / Number.NEGATIVE_INFINITY;
          var textNode = document.getElementById("x").nextSibling;
          var arrayLikeFunction = function( /**/ foo/**/, /*/**/bar,
          /**/baz) {};
          arrayLikeFunction.splice = function() {};
          var tinyTypedArray = new Uint8Array([3]);
          var smallTypedArray = new Uint8Array(new ArrayBuffer(400));
          smallTypedArray["foo"] = "bar";
          var bigTypedArray = new Uint8Array(new ArrayBuffer(400 * 1000 * 1000));
          bigTypedArray["FAIL"] = "FAIL: Object.getOwnPropertyNames() should not have been run";
          var namespace = {};
          namespace.longSubNamespace = {};
          namespace.longSubNamespace.x = {};
          namespace.longSubNamespace.x.className = function(){};
          var instanceWithLongClassName = new namespace.longSubNamespace.x.className();
          var bigArray = [];
          bigArray.length = 200;
          bigArray.fill(1);
          var boxedNumberWithProps = new Number(42);
          boxedNumberWithProps[1] = "foo";
          boxedNumberWithProps["a"] = "bar";
          var boxedStringWithProps = new String("abc");
          boxedStringWithProps["01"] = "foo";
          boxedStringWithProps[3] = "foo";
          boxedStringWithProps["a"] = "bar";
        </script>`);
      await evaluateAndLog(p, [
        `console.log(regex1)`,
      ]);
      p.assertLog();
    });
  });
}


