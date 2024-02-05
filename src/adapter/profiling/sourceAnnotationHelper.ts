/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import Cdp from '../../cdp/api';
import Dap from '../../dap/api';
import { SourceContainer } from '../sourceContainer';

interface IEmbeddedLocation {
  lineNumber: number;
  columnNumber: number;
  source: Dap.Source;
}

export class SourceAnnotationHelper {
  private locationIdCounter = 0;
  private readonly locationsByRef = new Map<
    string,
    { id: number; callFrame: Cdp.Runtime.CallFrame; locations: Promise<IEmbeddedLocation[]> }
  >();

  constructor(private readonly sources: SourceContainer) {}

  public getLocationIdFor(callFrame: Cdp.Runtime.CallFrame) {
    const ref = [
      callFrame.functionName,
      callFrame.url,
      callFrame.scriptId,
      callFrame.lineNumber,
      callFrame.columnNumber,
    ].join(':');

    const existing = this.locationsByRef.get(ref);
    if (existing) {
      return existing.id;
    }

    const id = this.locationIdCounter++;
    this.locationsByRef.set(ref, {
      id,
      callFrame,
      locations: (async () => {
        const source = await this.sources.getScriptById(callFrame.scriptId)?.source;
        if (!source) {
          return [];
        }

        const locations = await this.sources.currentSiblingUiLocations({
          lineNumber: callFrame.lineNumber + 1,
          columnNumber: callFrame.columnNumber + 1,
          source,
        });

        return Promise.all(
          locations.map(async loc => ({ ...loc, source: await loc.source.toDap() })),
        );
      })(),
    });

    return id;
  }

  public getLocations() {
    return Promise.all(
      [...this.locationsByRef.values()]
        .sort((a, b) => a.id - b.id)
        .map(async l => ({ callFrame: l.callFrame, locations: await l.locations })),
    );
  }
}
