/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { diffArrays } from 'diff';
import { Fragment, FunctionComponent, h } from 'preact';
import { useState } from 'preact/hooks';
import {
  DiagnosticBreakpointArgs,
  IDiagnosticBreakpoint,
  IDiagnosticDump,
  IDiagnosticUiLocation,
} from '../adapter/diagnosics';
import Cdp from '../cdp/api';
import { flatten } from '../common/objUtils';
import { DecisionButtons } from './decisionButtons';
import { basename, isBrowserType, isNodeType, prettyName } from './diagnosticPaths';
import { useDump } from './useDump';
import { usePersistedState } from './usePersistentState';

export const BreakpointHelper: FunctionComponent = () => {
  const dump = useDump();

  return (
    <Fragment>
      {dump.breakpoints.map((bp, i) => <Breakpoint bp={bp} key={i} />)}
    </Fragment>
  );
};

const hasAnyMatchedCdpBreakpoint = (bp: IDiagnosticBreakpoint, dump: IDiagnosticDump) =>
  bp.cdp.some(bp => {
    if ('location' in bp.args) {
      return true; // set by script id
    }
    if (bp.args.url) {
      const url = bp.args.url;
      return dump.sources.some(s => s.url === url);
    }

    if (bp.args.urlRegex) {
      const re = new RegExp(bp.args.urlRegex);
      return dump.sources.some(s => re.test(s.url));
    }

    return false;
  });

const buildTracing = (bp: IDiagnosticBreakpoint, dump: IDiagnosticDump) => {
  let key = 0;
  const steps = [
    <li key={key++}>
      <p>✅ This breakpoint was initially set in:</p>
      <p>
        <code>{bp.source.path}</code> line {bp.params.line} column {bp.params.column || 1}
      </p>
    </li>,
  ];

  if (!hasAnyMatchedCdpBreakpoint(bp, dump)) {
    steps.push(<FailedToSetLocation bp={bp} key={key++} />);
    return steps;
  }

  steps.push(
    <li key={key++}>
      <p>✅ In the runtime, the breakpoint was set in:</p>
      <p>
        <ul>
          {bp.cdp.map((cdp, i) => <CdpBreakpoint cdp={cdp} index={i} key={i} />)}
        </ul>
      </p>
    </li>,
  );

  const applied = bp.cdp.filter(cdp => cdp.state === 1 /* Applied */);
  const uiLocations = flatten(
    applied.map(a => (a.state === 1 /* Applied */ ? a.uiLocations : [])),
  );
  if (!uiLocations.length) {
    steps.push(
      <li key={key++}>
        <NoUiLocation />
      </li>,
    );
    return steps;
  }

  steps.push(
    <li key={key++}>
      <p>
        ✅ The runtime acknowledged and adjusted the breakpoint, and it mapped back to the following
        locations:
      </p>
      <ul>
        {uiLocations.map((l, i) => <UiLocation loc={l} key={i} />)}
      </ul>
    </li>,
    <li key={key++}>
      <p>
        If this is not right, your compiled code might be out of date with your sources. If you
        don't think this is the case and something else is wrong, please{' '}
        <a href='https://github.com/microsoft/vscode-js-debug/issues/new/choose'>open an issue</a>!
      </p>
    </li>,
  );

  return steps;
};

const NoUiLocation: FunctionComponent = () => {
  const dump = useDump();

  return (
    <p>
      ❓ We sent the breakpoint, but it didn't bind to any locations. If this is unexpected:
      <ul>
        <li>
          Make sure that your program is loading or running this script. You can add a{' '}
          <code>debugger;</code> statement to check this: your program will pause when it hits it.
        </li>
        <li>
          If your breakpoint is set in certain places, such as on the last empty line of a file, the
          runtime might not be able to find anywhere to place it.
        </li>
        {isNodeType(dump) && (
          <li>
            Unless you{' '}
            <a href='https://code.visualstudio.com/docs/nodejs/nodejs-debugging#_breakpoint-validation'>
              run with --nolazy
            </a>
            , Node.js might not resolve breakpoints for code it hasn't parsed yet.
          </li>
        )}
        <li>If necessary, make sure your compiled files are up-to-date with your source files.</li>
      </ul>
    </p>
  );
};

const Breakpoint: FunctionComponent<{ bp: IDiagnosticBreakpoint }> = ({ bp }) => {
  if (!bp.source.path) {
    return null;
  }

  const dump = useDump();
  return (
    <div className='content source-container'>
      <h2>
        {prettyName(
          { absolutePath: bp.source.path as string, url: bp.source.path as string },
          dump,
        )}
        :{bp.params.line}:{bp.params.column || 1}
      </h2>
      <ul className='bp-tracing'>{buildTracing(bp, dump)}</ul>
    </div>
  );
};

const FailedToSetLocation: FunctionComponent<{ bp: IDiagnosticBreakpoint }> = ({ bp }) => {
  const dump = useDump();
  const desiredBasename = basename({ url: bp.source.path as string });
  const matchingSources = dump.sources.filter(
    src => basename(src).toLowerCase() === desiredBasename.toLowerCase(),
  );

  if (!matchingSources.length) {
    return (
      <li>
        <p>
          <NoMatchingSourceHelper basename={desiredBasename} />
        </p>
      </li>
    );
  }

  return (
    <li>
      <p>
        ❓ We couldn't find a corresponding source location, but found some other files with the
        same name:
      </p>
      <ul>
        {matchingSources.map(s => (
          <li key={s}>
            <TextDiff original={bp.source.path as string} updated={s.absolutePath || s.url} />
          </li>
        ))}
      </ul>
      {isBrowserType(dump)
        ? (
          <p>
            You may need to adjust the <code>webRoot</code> in your <code>launch.json</code>{' '}
            if you're building from a subfolder, or tweak your <code>sourceMapPathOverrides</code>.
          </p>
        )
        : (
          <p>
            If this is the same file, you may need to adjust your build tool{' '}
            {isBrowserType(dump) && (
              <Fragment>
                or <code>webRoot</code> in the launch.json
              </Fragment>
            )} to correct the paths.
          </p>
        )}
    </li>
  );
};

const TextDiff: FunctionComponent<{ original: string; updated: string }> = ({
  original,
  updated,
}) => (
  <span className='text-diff'>
    {diffArrays(original.split(/[/\\]/g), updated.split(/[/\\]/g), { ignoreCase: true }).map(
      (diff, i) => (
        <span className={diff.added ? 'add' : diff.removed ? 'rm' : ''} key={i}>
          {i > 0 ? '/' : ''}
          {diff.value.join('/')}
        </span>
      ),
    )}
  </span>
);

const UiLocation: FunctionComponent<{ loc: IDiagnosticUiLocation }> = ({ loc }) => {
  const dump = useDump();
  const source = dump.sources.find(s => s.sourceReference === loc.sourceReference);

  return (
    <Fragment>
      <code>{source?.absolutePath ?? source?.url ?? 'unknown'}</code> line {loc.lineNumber} column
      {' '}
      {loc.columnNumber}
    </Fragment>
  );
};

const CdpBreakpoint: FunctionComponent<{ cdp: DiagnosticBreakpointArgs; index: number }> = ({
  cdp,
  index,
}) => {
  const dump = useDump();
  const [showRegex, setShowRegex] = usePersistedState(`showCdpBp${index}`, false);
  const { url, line, col, regex } = 'location' in cdp.args
    ? {
      url: dump.sources.find(
        s =>
          !s.compiledSourceRefToUrl
          && s.scriptIds.includes(
            (cdp.args as Cdp.Debugger.SetBreakpointParams).location.scriptId,
          ),
      )?.url,
      regex: undefined,
      line: cdp.args.location.lineNumber + 1,
      col: (cdp.args.location.columnNumber || 0) + 1,
    }
    : {
      url: cdp.args.urlRegex ? demangleUrlRegex(cdp.args.urlRegex) : cdp.args.url,
      regex: cdp.args.urlRegex,
      line: cdp.args.lineNumber + 1,
      col: (cdp.args.columnNumber || 0) + 1,
    };

  return (
    <li>
      <p>
        <code>{url}</code> line {line} column {col}{' '}
        {regex && <a onClick={() => setShowRegex(!showRegex)}>via this regex</a>}
      </p>
      {showRegex && (
        <p>
          <code>{regex}</code>
        </p>
      )}
    </li>
  );
};

const demangleUrlRegex = (re: string) =>
  re
    .replace(/\[([[a-z])[A-Z]\]/g, (_, letter) => letter) // ugly case-sensivity regex groups
    .replace(/\\\\/, '\\') // escaped backslashes
    .replace(/\\\//g, '/') // escaped forward slashes
    .replace(/\|.+$/g, '') // drive absolute path (only keep file uri)
    .replace(/\\\./g, '.'); // escaped .

const enum NoMatchingSourceHint {
  Direct = 'Loaded in directly',
  SourceMap = 'Be parsed from a sourcemap',
}

const NoMatchingDecisionButtons = DecisionButtons([
  NoMatchingSourceHint.Direct,
  NoMatchingSourceHint.SourceMap,
]);

const NoMatchingSourceHelper: FunctionComponent<{ basename: string }> = ({ basename }) => {
  const dump = useDump();
  const [hint, setHint] = useState<NoMatchingSourceHint | undefined>(
    !basename.endsWith('.js') ? NoMatchingSourceHint.SourceMap : undefined,
  );

  return (
    <Fragment>
      <p>
        ❓ We couldn't find a corresponding source location, and didn't find any source with the
        name <code>{basename}</code>.
      </p>
      <p>
        How did you expect this file to be loaded? (If you have a compilation step, you should pick
        'sourcemap')
        <NoMatchingDecisionButtons onChange={setHint} value={hint} />
        {hint === NoMatchingSourceHint.Direct
          && (isBrowserType(dump)
            ? (
              <p>
                It looks like your webpage didn't load this script; breakpoints won't be bound until
                the file they're set in is loaded. Make sure your script is imported from the right
                location using a <code>{'<script>'}</code> tag.
              </p>
            )
            : (
              <p>
                It looks like your program didn't load this script; breakpoints won't be bound until
                the file they're set in is loaded. Make sure your script is imported with a{' '}
                <code>require()</code> or <code>import</code> statement, such as{' '}
                <code>require('./{basename}')</code>.
              </p>
            ))}
        {hint === NoMatchingSourceHint.SourceMap && (
          <p>
            Here's some hints that might help you:
            <ul>
              {/\.tsx?$/.test(basename)
                ? (
                  <li>
                    Make sure you have <code>"sourceMap": true</code>{' '}
                    in your tsconfig to generate sourcemaps.
                  </li>
                )
                : <li>Make sure your build tool is set up to create sourcemaps.</li>}
              {!dump.config.outFiles.includes('!**/node_modules/**') && (
                <li>
                  It looks like you narrowed the <code>outFiles</code>{' '}
                  in your launch.json. Try removing this: it now defaults to the whole workspace,
                  and overspecifying it can unnecessarily narrow places where we'll resolve
                  sourcemaps.
                </li>
              )}
            </ul>
          </p>
        )}
      </p>
    </Fragment>
  );
};
