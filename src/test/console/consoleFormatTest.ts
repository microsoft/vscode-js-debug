/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { OutputSource } from '../../configuration';
import { createFileTree } from '../createFileTree';
import { testFixturesDir } from '../test';
import { itIntegrates } from '../testIntegrationUtils';

describe('console format', () => {
  itIntegrates('string', async ({ r }) => {
    const p = await r.launchAndLoad(`
        <script>
          var array = ["test", "test2"];array.length = 10;
          array.foo = {};
          array[4] = "test4";
        </script>`);
    await p.logger.evaluateAndLog([
      `console.log(array)`,
      `console.log("hello world".repeat(10000))`,
      `console.log("%o", array)`,
      `console.log("%O", array)`,
      `console.log("Test for zero \\"%f\\" in formatter", 0)`,
      `console.log("%% self-escape1", "dummy")`,
      `console.log("%%s self-escape2", "dummy")`,
      `console.log("%%ss self-escape3", "dummy")`,
      `console.log("%%s%s%%s self-escape4", "dummy")`,
      `console.log("%%%%% self-escape5", "dummy")`,
      `console.log("%%%s self-escape6", "dummy");`,
    ]);
    p.assertLog();
  });

  itIntegrates('string format', async ({ r }) => {
    const handle = await r.launchUrl('stringFormats.html');
    handle.load();

    const obj = await handle.dap.once('output');
    for (let i = 0; i < 4; i++) {
      // xa - xd
      await handle.logger.logOutput(await handle.dap.once('output'));
    }
    await handle.logger.logOutput(obj);

    for (const context of ['hover', 'repl'] as const) {
      await handle.logger.evaluateAndLog('obj', { depth: 1 }, context);
      await handle.logger.evaluateAndLog('xa', { depth: 1 }, context);
      await handle.logger.evaluateAndLog('xb', { depth: 1 }, context);
      await handle.logger.evaluateAndLog('xc', { depth: 1 }, context);
      await handle.logger.evaluateAndLog('xd', { depth: 1 }, context);
    }

    handle.assertLog();
  });

  itIntegrates('popular types', async ({ r }) => {
    const p = await r.launchAndLoad(`
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
      'regex1',
      'regex2',
      'str',
      'str2',
      'error',
      'errorWithMessage',
      'errorWithMultilineMessage',
      'func',
      'multilinefunc',
      'num',
      'null',
      'undefined',
      'NaN',
      'Number.POSITIVE_INFINITY',
      'Number.NEGATIVE_INFINITY',
      '{}',
      '[function() {}]',
      'objectWithNonEnumerables',
      'negZero',
      'Object.create(null)',
      'Object',
      'Object.prototype',
      'new Number(42)',
      'new String("abc")',
      'arrayLikeFunction',
      'new Uint16Array(["1", "2", "3"])',
      'tinyTypedArray',
      'smallTypedArray',
      'bigTypedArray',
      'throwingLengthGetter',
      'domException()',
      'bigArray',
      'boxedNumberWithProps',
      'boxedStringWithProps',
      'false',
      'true',
      'node',
      'new Boolean(true)',
      'new Set([1, 2, 3, 4])',
      'new Set([1, 2, 3, 4, 5, 6, 7, 8])',
      'new class { toString() { return "custom to string" } }',
      'new class { toString() { return "long custom to string".repeat(500) } }',
      'new class { [Symbol.for("debug.description")]() { return "some custom repr" } }',
      'new class { [Symbol.for("nodejs.util.inspect.custom")](depth) { return "some node repr, depth: " + depth } }',
    ];
    const expressions = variables.map(v => [`console.log(${v})`, `console.log([${v}])`]);
    await p.logger.evaluateAndLog(([] as string[]).concat(...expressions), { depth: 0 });
    p.assertLog();
  });

  itIntegrates('custom toString', async ({ r }) => {
    const p = await r.launchAndLoad('blank');
    await p.logger.evaluateAndLog(`
      new class A {
        prop = new class B {
          toString() { return "hello b" }
        }
        toString() { return "hello a" }
      }
    `);
    p.assertLog();
  });

  itIntegrates('custom symbol', async ({ r }) => {
    const p = await r.launchAndLoad('blank');
    await p.logger.evaluateAndLog(`
      new class A {
        prop = new class B {
          [Symbol.for("debug.description")]() { return "hello b" }
        };
        [Symbol.for("debug.description")]() { return "hello a" }
      }
    `);
    p.assertLog();
  });

  itIntegrates('collections', async ({ r }) => {
    const p = await r.launchAndLoad(`
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
      'nodelist',
      'htmlcollection',
      'options',
      'all',
      'formControls',
      'radioNodeList',
      'arrayX',
      'nonArray',
      'generateArguments(1, "2")',
      'div.classList',
    ];
    const expressions = variables.map(v => [`console.log(${v})`, `console.log([${v}])`]);
    await p.logger.evaluateAndLog(([] as string[]).concat(...expressions), { depth: 0 });
    p.assertLog();
  });

  itIntegrates('es6', async ({ r }) => {
    const p = await r.launchAndLoad(`
        <script>
          var p = Promise.reject(-0);
          p.catch(function() {});

          var p2 = Promise.resolve(1);
          var p3 = new Promise(() => {});

          var smb1 = Symbol();
          var smb2 = Symbol("a");
          var obj = {
              get getter() {}
          };
          obj["a"] = smb1;
          obj[smb2] = 2;

          var map = new Map();
          var weakMap = new WeakMap();
          map.set(obj, {foo: 1});
          weakMap.set(obj, {foo: 1});

          var set = new Set();
          var weakSet = new WeakSet();
          set.add(obj);
          weakSet.add(obj);

          var mapMap0 = new Map();
          mapMap0.set(new Map(), new WeakMap());
          var mapMap = new Map();
          mapMap.set(map, weakMap);

          var setSet0 = new Set();
          setSet0.add(new WeakSet());
          var setSet = new Set();
          setSet.add(weakSet);

          var bigmap = new Map();
          bigmap.set(" from str ", " to str ");
          bigmap.set(undefined, undefined);
          bigmap.set(null, null);
          bigmap.set(42, 42);
          bigmap.set({foo:"from"}, {foo:"to"});
          bigmap.set(["from"], ["to"]);

          var genFunction = function *() {
              yield 1;
              yield 2;
          }
          var generator = genFunction();
        </script>`);

    const variables = [
      'p',
      'p2',
      'p3',
      'smb1',
      'smb2',
      'obj',
      'map',
      'weakMap',
      'set',
      'weakSet',
      'mapMap0',
      'mapMap',
      'setSet0',
      'setSet',
      'bigmap',
      'generator',
    ];
    const expressions = variables.map(v => [`console.log(${v})`, `console.log([${v}])`]);
    await p.logger.evaluateAndLog(([] as string[]).concat(...expressions), { depth: 0 });
    p.assertLog();
  });

  itIntegrates('es6-2', async ({ r }) => {
    const p = await r.launchAndLoad(`
        <script>
          var map2 = new Map();
          map2.set(41, 42);
          map2.set({foo: 1}, {foo: 2});

          var iter1 = map2.values();
          iter1.next();

          var set2 = new Set();
          set2.add(41);
          set2.add({foo: 1});

          var iter2 = set2.keys();
          iter2.next();
        </script>`);

    const variables = [
      'map2.keys()',
      'map2.values()',
      'map2.entries()',
      'set2.keys()',
      'set2.values()',
      'set2.entries()',
      'iter1',
      'iter2',
    ];
    const expressions = variables.map(v => [`console.log(${v})`, `console.log([${v}])`]);
    await p.logger.evaluateAndLog(([] as string[]).concat(...expressions), { depth: 0 });
    p.assertLog();
  });

  itIntegrates('array', async ({ r }) => {
    const p = await r.launchAndLoad(`
        <script>
          var a0 = [];
          var a1 = []; a1.length = 1;
          var a2 = []; a2.length = 5;
          var a3 = [,2,3];
          var a4 = []; a4.length = 15;
          var a5 = []; a5.length = 15; a5[8] = 8;
          var a6 = []; a6.length = 15; a6[0] = 0; a6[10] = 10;
          var a7 = [,,,4]; a7.length = 15;
          for (var i = 0; i < 6; ++i)
              a7["index" + i] = i;
          var a8 = [];
          for (var i = 0; i < 10; ++i)
              a8[i] = i;
          var a9 = [];
          for (var i = 1; i < 5; ++i) {
              a9[i] = i;
              a9[i + 5] = i + 5;
          }
          a9.length = 11;
          a9.foo = "bar";
          a10 = Object.create([1,2]);
        </script>`);

    const expressions = new Array(11).fill(0).map((a, b) => `console.log(a${b})`);
    await p.logger.evaluateAndLog(expressions, { depth: 0 });
    p.assertLog();
  });

  itIntegrates('class', async ({ r }) => {
    const p = await r.launchAndLoad(`
        <script>
          var a0 = [];
          var a1 = []; a1.length = 1;
          var a2 = []; a2.length = 5;
          var a3 = [,2,3];
          var a4 = []; a4.length = 15;
          var a5 = []; a5.length = 15; a5[8] = 8;
          var a6 = []; a6.length = 15; a6[0] = 0; a6[10] = 10;
          var a7 = [,,,4]; a7.length = 15;
          for (var i = 0; i < 6; ++i)
              a7["index" + i] = i;
          var a8 = [];
          for (var i = 0; i < 10; ++i)
              a8[i] = i;
          var a9 = [];
          for (var i = 1; i < 5; ++i) {
              a9[i] = i;
              a9[i + 5] = i + 5;
          }
          a9.length = 11;
          a9.foo = "bar";
          a10 = Object.create([1,2]);
        </script>`);

    const expressions = new Array(11).fill(0).map((a, b) => `console.log(a${b})`);
    await p.logger.evaluateAndLog(expressions, { depth: 0 });
    p.assertLog();
  });

  itIntegrates('groups', async ({ r }) => {
    const p = await r.launchAndLoad('blank');
    await p.logger.evaluateAndLog([
      `console.log('outer')`,
      `console.group()`,
      `console.log('in anonymous')`,
      `console.groupCollapsed('named')`,
      `console.log('in named')`,
      `console.group({ complex: true })`,
      `console.log('in complex')`,
      `console.groupEnd()`,
      `console.groupEnd()`,
      `console.log('back in anonymous')`,
      `console.groupEnd()`,
    ]);
    p.assertLog();
  });

  itIntegrates('colors', async ({ r }) => {
    const p = await r.launchAndLoad(`blank`);

    await p.logger.evaluateAndLog(
      [
        `console.log('%cColors are awesome.', 'color: blue;')`,
        `console.log('%cColors are awesome.', 'background-color: red;')`,
        `console.log('%cColors are awesome.', 'background-color: red;', 'Do not apply to trailing params')`,
        `console.log('%cColors %care %cawesome.', 'color: red', 'color:green', 'color:blue')`,
        `console.log('%cBold text.', 'font-weight: bold')`,
        `console.log('%cItalic text.', 'font-style: italic')`,
        `console.log('%cUnderline text.', 'text-decoration: underline')`,
      ],
      { depth: 0 },
    );
    p.assertLog();
  });

  itIntegrates('nodes', async ({ r }) => {
    const p = await r.launchAndLoad(`
      <div id="main">
        Content
        <p>Paragaph</p>
        More content
        <div></div>
      </div>
    `);

    await p.logger.evaluateAndLog('document.getElementById("main")', {
      depth: 3,
      omitProperties: ['Node Attributes', '[[Prototype]]'],
    });
    p.assertLog();
  });

  itIntegrates('error traces in source maps', async ({ r }) => {
    const handle = await r.launchUrlAndLoad('browserify/browserify.html');
    await handle.logger.evaluateAndLog(['try { throwError() } catch (e) { console.error(e) }']);
    handle.assertLog();
  });

  itIntegrates('adds error traces if they do not exist', async ({ r }) => {
    const handle = await r.launchUrlAndLoad('browserify/browserify.html');
    const output = handle.dap.once('output');
    await handle.logger.evaluateAndLog(['setTimeout(() => { throw "asdf" }, 0) ']);
    handle.log(await output);
    handle.assertLog();
  });

  itIntegrates('applies skipfiles to logged stacks', async ({ r }) => {
    const handle = await r.launchAndLoad(
      `
        <script>
        function doLog() { console.log.apply(console, arguments); }
        //# sourceURL=ignore-me.js
        </script>
      `,
      { skipFiles: ['**/ignore-me.js'] },
    );

    const evaluation = handle.dap.evaluate({
      expression: 'doLog("hello world");\n//# sourceURL=dont-ignore-me.js',
      context: 'watch',
    });
    const output = await handle.dap.once('output');
    await evaluation;
    handle.log(
      `logged ${output.output} at ${output.source?.name}:${output.line}:${output.column}`,
    );
    handle.assertLog();
  });

  itIntegrates('EXT handling', async ({ r }) => {
    createFileTree(testFixturesDir, {
      'test.js': [
        `
          process.stdout.write('hello');
          debugger;
          process.stdout.write('world');
          debugger;
          process.stdout.write('new line\\r\\nasdf');
          debugger;
          process.stdout.write('now ext\\u0003this should be bulked');
          debugger;
          process.stdout.write('with this!\\u0003trailing');
        `,
      ],
    });
    const handle = await r.runScript('test.js', { outputCapture: OutputSource.Stdio });
    let output = '';
    r.rootDap().on('output', o => {
      output += o.output;
    });

    // use debugger statements to sync chunks of output
    handle.dap.on('stopped', ev => {
      handle.dap.continue({ threadId: ev.threadId! });
    });

    await handle.load();
    await r.rootDap().once('terminated');
    r.log(JSON.stringify(output));
    handle.assertLog();
  });
});
