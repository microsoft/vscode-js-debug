const glob = require('glob');
const path = require('path');
const fs = require('fs');

exports.dirname = filter => ({
  name: 'dirname',
  setup: build => {
    build.onLoad({ filter }, async ({ path: filePath }) => {
      const contents = await fs.promises.readFile(filePath, 'utf-8');
      return {
        contents: contents
          .replace(/__dirname/g, JSON.stringify(path.dirname(filePath)))
          .replace(/__filename/g, JSON.stringify(path.dirname(filePath))),
        loader: path.extname(filePath).slice(1),
      };
    });
  },
});

exports.hackyVendorBundle = vendors => ({
  name: 'hackyVendorBundle',
  setup: build => {
    const vendorNames = [...vendors.keys()];

    build.onResolve(
      { filter: new RegExp(`^(${vendorNames.join('|')})$`), namespace: 'file' },
      args => ({
        path: vendors.get(args.path),
        external: true,
        sideEffects: false,
      }),
    );
  },
});

// https://github.com/evanw/esbuild/issues/1051#issuecomment-806325487
exports.nativeNodeModulesPlugin = () => ({
  name: 'native-node-modules',
  setup(build) {
    // If a ".node" file is imported within a module in the "file" namespace, resolve
    // it to an absolute path and put it into the "node-file" virtual namespace.
    build.onResolve({ filter: /\.node$/, namespace: 'file' }, args => ({
      path: require.resolve(args.path, { paths: [args.resolveDir] }),
      namespace: 'node-file',
    }));

    // Files in the "node-file" virtual namespace call "require()" on the
    // path from esbuild of the ".node" file in the output directory.
    build.onLoad({ filter: /.*/, namespace: 'node-file' }, args => ({
      contents: `
        import path from ${JSON.stringify(args.path)}
        try { module.exports = require(path) }
        catch {}
      `,
    }));

    // If a ".node" file is imported within a module in the "node-file" namespace, put
    // it in the "file" namespace where esbuild's default loading behavior will handle
    // it. It is already an absolute path since we resolved it to one above.
    build.onResolve({ filter: /\.node$/, namespace: 'node-file' }, args => ({
      path: args.path,
      namespace: 'file',
    }));

    // Tell esbuild's default loading behavior to use the "file" loader for
    // these ".node" files.
    let opts = build.initialOptions;
    opts.loader = opts.loader || {};
    opts.loader['.node'] = 'file';
  },
});

/**
 * Based on https://github.com/thomaschaaf/esbuild-plugin-import-glob,
 * but modified so imports are async in order to work with mocha's loading,
 * which requires events around file loads.
 *
 * @license
 *
 * MIT License
 *
 * Copyright (c) 2021 Thomas Schaaf
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
exports.importGlobLazy = () => ({
  name: 'import-glob-lazy',
  setup: build => {
    build.onResolve({ filter: /\*/ }, async args => {
      if (args.resolveDir === '') {
        return; // Ignore unresolvable paths
      }

      return {
        path: args.path,
        namespace: 'import-glob-lazy',
        pluginData: {
          resolveDir: args.resolveDir,
        },
      };
    });

    build.onLoad({ filter: /.*/, namespace: 'import-glob-lazy' }, async args => {
      const files = glob
        .sync(args.path, {
          cwd: args.pluginData.resolveDir,
        })
        .sort()
        .map(m => `[${JSON.stringify(m)}, () => import(${JSON.stringify(`./${m}`)})]`); // CodeQL [SM03611] Bad detection, esbuild plugin used for imports

      const importerCode = `
        const modules = new Map([${files.join(',\n')}]);
        export default modules;
      `;

      return { contents: importerCode, resolveDir: args.pluginData.resolveDir };
    });
  },
});
