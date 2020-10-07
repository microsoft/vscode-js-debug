/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import Fuse from 'fuse.js';
import { FunctionComponent, h } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import { IDiagnosticDump, IDiagnosticSource } from '../adapter/diagnosics';

export const SourceExplorer: FunctionComponent<{ dump: IDiagnosticDump }> = ({ dump }) => {
  const fuse = useMemo(
    () =>
      new Fuse(dump.sources, {
        keys: ['url', 'absolutePath', 'actualAbsolutePath'],
      }),
    dump.sources,
  );

  const [filter, setFilter] = useState('');
  const results = useMemo(() => fuse.search(filter), [fuse, filter]);

  return (
    <div className="content">
      <input
        placeholder="Filter sources..."
        value={filter}
        onChange={evt => setFilter((evt.target as HTMLInputElement).value)}
      />
      {results.map(result => (
        <Source key={result.item.sourceReference} source={result.item} allSources={dump.sources} />
      ))}
    </div>
  );
};

export const Source: FunctionComponent<{
  source: IDiagnosticSource;
  allSources: ReadonlyArray<IDiagnosticSource>;
}> = ({ source, allSources }) => {
  const [breadcrumbs, setBreadcrumbs] = useState([source]);

  return (
    <div className="source-container">
      <Breadcrumbs sources={breadcrumbs} update={setBreadcrumbs} />
      <h1>{source.url}</h1>
      <SourceData
        source={breadcrumbs[breadcrumbs.length - 1]}
        open={sourceReference => {
          const src = allSources.find(s => s.sourceReference === sourceReference);
          if (src) {
            setBreadcrumbs(breadcrumbs.concat(src));
          }
        }}
      />
    </div>
  );
};

const Breadcrumbs: FunctionComponent<{
  sources: ReadonlyArray<IDiagnosticSource>;
  update(sources: IDiagnosticSource[]): void;
}> = ({ sources, update }) => (
  <ol>
    {sources.map((source, i) => {
      const label = `${basename(source)} (#${source.sourceReference})`;
      return i === sources.length - 1 ? (
        label
      ) : (
        <a key={i} onClick={() => update(sources.slice(0, i + 1))}>
          {label}
        </a>
      );
    })}
  </ol>
);

const SourceData: FunctionComponent<{
  source: IDiagnosticSource;
  open(sourceRef: number): void;
}> = ({ source }) => (
  <div className="source">
    <h1>{source.url}</h1>
  </div>
);

const basename = (source: IDiagnosticSource) => {
  const parts = (source.prettyName || source.url).split(/\\|\//g);
  return parts[parts.length - 1];
};
