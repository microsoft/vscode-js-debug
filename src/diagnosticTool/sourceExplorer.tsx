/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { Fragment, FunctionComponent, h } from 'preact';
import { useCallback, useMemo } from 'preact/hooks';
import { IDiagnosticSource } from '../adapter/diagnosics';
import { truthy } from '../common/objUtils';
import { basename, prettyName, sortScore } from './diagnosticPaths';
import { useDump } from './useDump';
import { usePersistedState } from './usePersistentState';

export const SourceExplorer: FunctionComponent = () => {
  const dump = useDump();

  const uniqueIdMap = useMemo(() => {
    const map = new Map<number, IDiagnosticSource>();
    for (const source of dump.sources) {
      map.set(source.uniqueId, source);
    }
    return map;
  }, [dump.sources]);

  const indexed = useMemo(
    () =>
      dump.sources
        .map(
          source =>
            [
              [source.url, source.absolutePath, source.prettyName].join(' ').toLowerCase(),
              source,
            ] as [string, IDiagnosticSource],
        )
        .sort((a, b) => sortScore(a[1]) - sortScore(b[1])),
    [dump.sources],
  );

  const [filter, setFilter] = usePersistedState('filter', '');
  const results = useMemo(
    () =>
      filter
        ? indexed.filter(([str]) => str.includes(filter.toLowerCase())).map(([, src]) => src)
        : indexed.map(i => i[1]),
    [indexed, filter],
  );
  const onChange = useCallback(
    (evt: Event) => setFilter((evt.target as HTMLInputElement).value),
    [],
  );

  return (
    <Fragment>
      <input
        placeholder='Filter sources...'
        className='source-filter'
        value={filter}
        onChange={onChange}
        onKeyUp={onChange}
      />
      <small style={{ marginBottom: '1rem' }}>
        Showing {results.length} of {dump.sources.length} sources...
      </small>
      {results.map(result => (
        <Source source={result} allSources={uniqueIdMap} key={result.sourceReference} />
      ))}
    </Fragment>
  );
};

export const Source: FunctionComponent<{
  source: IDiagnosticSource;
  allSources: Map<number, IDiagnosticSource>;
}> = ({ source, allSources }) => {
  const [rawBreadcrumbs, setBreadcrumbs] = usePersistedState(
    `sourceBreadCrumbs${source.uniqueId}`,
    [source.uniqueId],
  );
  const breadcrumbs = useMemo(
    () => rawBreadcrumbs.map(b => allSources.get(b)).filter(truthy),
    [allSources, rawBreadcrumbs],
  );
  const [expanded, setExpanded] = usePersistedState(`sourceExpanded${source.uniqueId}`, false);
  const dump = useDump();
  const toggleExpand = useCallback(() => setExpanded(!expanded), [expanded]);

  return (
    <div className={`source-container ${expanded ? ' expanded' : ''}`}>
      <h2 onClick={toggleExpand}>{prettyName(source, dump)}</h2>
      {expanded && (
        <Fragment>
          {breadcrumbs.length > 1 && <Breadcrumbs sources={breadcrumbs} update={setBreadcrumbs} />}
          <SourceData
            source={breadcrumbs[breadcrumbs.length - 1]}
            open={sourceReference => {
              const src = dump.sources.find(s => s.sourceReference === sourceReference);
              if (src) {
                setBreadcrumbs(rawBreadcrumbs.concat(src.uniqueId));
              }
            }}
          />
        </Fragment>
      )}
    </div>
  );
};

const Breadcrumbs: FunctionComponent<{
  sources: ReadonlyArray<IDiagnosticSource>;
  update(sources: number[]): void;
}> = ({ sources, update }) => (
  <ol className='source-breadcrumbs'>
    {sources.map((source, i) => {
      const label = `${basename(source)} (#${source.sourceReference})`;
      if (i === sources.length - 1) {
        return <li>{label}</li>;
      }

      return (
        <li key={i}>
          <a key={i} onClick={() => update(sources.slice(0, i + 1).map(s => s.uniqueId))}>
            {label}
          </a>{' '}
          &raquo;{' '}
        </li>
      );
    })}
  </ol>
);

const SourceData: FunctionComponent<{
  source: IDiagnosticSource;
  open(sourceRef: number): void;
}> = ({ source, open }) => (
  <dl className='source-data-grid'>
    <dt>url</dt>
    <dd>
      <code>{source.url}</code>
    </dd>
    <dt>sourceReference</dt>
    <dd>
      <code>{source.sourceReference}</code>
    </dd>
    <dt>absolutePath</dt>
    <dd>
      <code>{source.absolutePath}</code>
    </dd>
    <dt>absolutePath verified?</dt>
    <dd>
      {source.compiledSourceRefToUrl
        ? '✅ From sourcemap, assumed correct'
        : source.actualAbsolutePath
        ? '✅ Verified on disk'
        : '❌ Disk verification failed (does not exist or different content)'}
    </dd>
    <dt>sourcemap children:</dt>
    <dd>
      {source.sourceMap
        ? (
          <ul>
            {Object.entries(source.sourceMap.sources).map(([url, ref]) => (
              <li key={url}>
                <ReferencedSource url={url} sourceRef={ref} pick={open} />
              </li>
            ))}
          </ul>
        )
        : (
          'None (does not have a sourcemap)'
        )}
    </dd>
    <dt>referenced from sourcemap:</dt>
    <dd>
      {source.compiledSourceRefToUrl
        ? (
          <ul>
            {source.compiledSourceRefToUrl.map(([ref, url]) => (
              <li key={url}>
                <SourceFromReference url={url} sourceRef={ref} pick={open} />
              </li>
            ))}
          </ul>
        )
        : (
          'None (not from a sourcemap)'
        )}
    </dd>
  </dl>
);

const ReferencedSource: FunctionComponent<{
  url: string;
  sourceRef: number;
  pick(ref: number): void;
}> = ({ url, sourceRef, pick }) => {
  const dump = useDump();
  const src = dump.sources.find(s => s.sourceReference === sourceRef);
  const onClick = useCallback(() => pick(sourceRef), [sourceRef]);
  return (
    <Fragment>
      {url} &rarr; <a onClick={onClick}>{src ? `${basename(src)} (#${sourceRef})` : 'unknown'}</a>
    </Fragment>
  );
};

const SourceFromReference: FunctionComponent<{
  url: string;
  sourceRef: number;
  pick(sourceRef: number): void;
}> = ({ url, sourceRef, pick }) => {
  const dump = useDump();
  const src = dump.sources.find(s => s.sourceReference === sourceRef);
  const onClick = useCallback(() => pick(sourceRef), [sourceRef]);
  return (
    <Fragment>
      <a onClick={onClick}>{src ? `${basename(src)} (#${sourceRef})` : 'unknown'}</a> as {url}{' '}
      &rarr; this
    </Fragment>
  );
};
