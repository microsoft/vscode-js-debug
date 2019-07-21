// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { TestP } from '../test';

export function addTests(testRunner) {
  // @ts-ignore unused xit/fit variables.
  const { it, fit, xit, describe, fdescribe, xdescribe } = testRunner;

  async function evaluateAndLog(p: TestP, expressions: string[], depth: number) {
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
        await p.logger.logOutput(params, depth);
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
      ], 1);
      p.assertLog();
    });

    it('popular types', async ({ p }: { p: TestP }) => {
      await p.launchAndLoad(`
        <p id="p"></p>
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
          var arrayLikeFunction = function( /**/ foo/**/, /*/**/bar,
          /**/baz) {};
          arrayLikeFunction.splice = function() {};
          var tinyTypedArray = new Uint8Array([3]);
          var smallTypedArray = new Uint8Array(new ArrayBuffer(400));
          smallTypedArray["foo"] = "bar";
          var bigTypedArray = new Uint8Array(new ArrayBuffer(400 * 1000 * 1000));
          bigTypedArray["FAIL"] = "FAIL: Object.getOwnPropertyNames() should not have been run";
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
          function domException()
          {
              var result = "FAIL";
              try {
                  var a = document.createElement("div");
                  var b = document.createElement("div");
                  a.removeChild(b);
              } catch(e) {
                  e.stack = "";
                  result = e;
              }
              return result;
          }
          //# sourceURL=console-format
        </script>`);
      const variables = [
        'regex1', 'regex2', 'str', 'str2', 'error', 'errorWithMessage', 'errorWithMultilineMessage', 'func', 'multilinefunc', 'num',
        'null', 'undefined', 'NaN', 'Number.POSITIVE_INFINITY', 'Number.NEGATIVE_INFINITY', '{}', '[function() {}]',
        'objectWithNonEnumerables', 'negZero', 'Object.create(null)', 'Object', 'Object.prototype',
        'new Number(42)', 'new String("abc")', 'arrayLikeFunction', 'new Uint16Array(["1", "2", "3"])',
        'tinyTypedArray', 'smallTypedArray', 'bigTypedArray', 'throwingLengthGetter', 'domException()', 'bigArray',
        'boxedNumberWithProps', 'boxedStringWithProps'
      ];
      await evaluateAndLog(p, variables.map(v => `console.log(${v})`), 0),
      p.assertLog();
    });

    it('collections', async ({ p }: { p: TestP }) => {
      await p.launchAndLoad(`
        <div style="display:none" class="c1 c2 c3">
          <form id="f">
              <select id="sel" name="sel">
                  <option value="1">one</option>
                  <option value="2">two</option>
              </select>
              <input type="radio" name="x" value="x1"> x1
              <input type="radio" name="x" value="x2"> x2
          </form>
        </div>
        <script>
          var formElement = document.getElementById("f");
          var selectElement = document.getElementById("sel");
          var spanElement = document.getElementById("span");

          // NodeList
          var nodelist = document.getElementsByTagName("select");
          var htmlcollection = document.head.children;
          var options = selectElement.options;
          var all = document.all;
          var formControls = formElement.elements;
          var radioNodeList = formElement.x;

          var arrayX = [1];
          var arrayY = [2, arrayX];
          arrayX.push(arrayY);

          var nonArray = new NonArrayWithLength();
          // Arguments
          function generateArguments(foo, bar)
          {
              return arguments;
          }

          var div = document.getElementsByTagName("div")[0];

          function NonArrayWithLength() {
              this.keys = [];
          }

          NonArrayWithLength.prototype.__defineGetter__("length", function() {
              console.log("FAIL: 'length' should not be called");
              return this.keys.length;
          });
        </script>`);

      const variables = [
        'nodelist', 'htmlcollection', 'options', 'all',
        'formControls', 'radioNodeList', 'arrayX', 'nonArray',
        'generateArguments(1, "2")', 'div.classList'
      ];
      await evaluateAndLog(p, variables.map(v => `console.log(${v})`), 0),
      p.assertLog();
    });
  });
}


