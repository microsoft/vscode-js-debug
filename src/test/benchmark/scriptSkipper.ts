/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { IBenchmarkApi } from '@c4312/matcha';
import { ScriptSkipper } from '../../adapter/scriptSkipper/implementation';
import { Source } from '../../adapter/source';
import Connection from '../../cdp/connection';
import { NullTransport } from '../../cdp/nullTransport';
import { Logger } from '../../common/logging/logger';
import { upcastPartial } from '../../common/objUtils';
import { ISourcePathResolver } from '../../common/sourcePathResolver';
import { AnyLaunchConfiguration } from '../../configuration';
import { ITarget } from '../../targets/targets';
import { NullTelemetryReporter } from '../../telemetry/nullTelemetryReporter';

const skipper = new ScriptSkipper(
  { skipFiles: ['<node_internals>/**', '/foo/*.js'] } as unknown as AnyLaunchConfiguration,
  upcastPartial<ISourcePathResolver>({ rebaseLocalToRemote: p => p }),
  Logger.null,
  new Connection(new NullTransport(), Logger.null, new NullTelemetryReporter()).createSession(''),
  {
    type: () => 'browser',
    id: () => 'a',
    parent: () => undefined,
  } as Partial<ITarget> as ITarget,
);

const notSkipped = {
  url: 'file:///not-skipped.js',
  absolutePath: '/not-skipped.js',
  scriptIds: () => ['41'],
} as Partial<Source> as Source;

const isSkipped = {
  url: 'file:///foo/bar.js',
  absolutePath: '/foo/bar.js',
  scriptIds: () => ['42'],
} as Partial<Source> as Source;

export default function(api: IBenchmarkApi) {
  api.bench(
    'initializeSkippingValueForSource not skipped',
    () => skipper.initializeSkippingValueForSource(notSkipped),
  );

  api.bench(
    'initializeSkippingValueForSource with skipped',
    () => skipper.initializeSkippingValueForSource(isSkipped),
  );
}
