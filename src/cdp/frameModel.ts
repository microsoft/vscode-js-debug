// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import Cdp from './api';
import { EventEmitter } from 'events';
import { URL } from 'url';
import * as path from 'path';

export const FrameModelEvents = {
  FrameAdded: Symbol('FrameAdded'),
  FrameDetached: Symbol('FrameDetached'),
  FrameNavigated: Symbol('FrameNavigated'),
  MainFrameNavigated: Symbol('MainFrameNavigated'),
};

export class FrameModel extends EventEmitter {
  private _mainFrame?: Frame;

  _frames: Map<string, Frame> = new Map();

  async addTarget(cdp: Cdp.Api): Promise<boolean> {
    await cdp.Page.enable({});
    const result = await cdp.Page.getResourceTree({});
    if (!result)
      return false;
    this._processCachedResources(cdp, result.frameTree);
    return true;
  }

  mainFrame(): Frame | undefined {
    return this._mainFrame;
  }

  _processCachedResources(cdp: Cdp.Api, mainFramePayload: Cdp.Page.FrameResourceTree | null) {
    if (mainFramePayload) {
      const parentFrame = mainFramePayload.frame.parentId ? this._frames.get(mainFramePayload.frame.parentId) : undefined;
      this._addFramesRecursively(cdp, mainFramePayload, parentFrame);
    }
    cdp.Page.on('frameAttached', event => {
      this._frameAttached(cdp, event.frameId, event.parentFrameId);
    });
    cdp.Page.on('frameNavigated', event => {
      this._frameNavigated(cdp, event.frame);
    });
    cdp.Page.on('frameDetached', event => {
      this._frameDetached(cdp, event.frameId);
    });
    this._frameStructureUpdated();
  }

  _addFrame(cdp: Cdp.Api, frameId: Cdp.Page.FrameId, parentFrame?: Frame): Frame {
    const frame = new Frame(this, cdp, frameId, parentFrame);
    this._frames.set(frame.id, frame);
    if (frame.isMainFrame())
      this._mainFrame = frame;
    this.emit(FrameModelEvents.FrameAdded, frame);
    return frame;
  }

  _frameAttached(cdp: Cdp.Api, frameId: Cdp.Page.FrameId, parentFrameId: Cdp.Page.FrameId | null): Frame | null {
    if (this._frames.has(frameId))
      return null;

    const parentFrame = parentFrameId ? (this._frames.get(parentFrameId)) : undefined;
    const frame = this._addFrame(cdp, frameId, parentFrame);
    this._frameStructureUpdated();
    return frame;
  }

  _frameNavigated(cdp: Cdp.Api, framePayload: Cdp.Page.Frame) {
    let frame: Frame | null = this._frames.get(framePayload.id) || null;
    if (!frame) {
      // Simulate missed "frameAttached" for a main frame navigation to the new backend process.
      frame = this._frameAttached(cdp, framePayload.id, framePayload.parentId || '') as Frame;
      console.assert(frame);
    }

    frame._navigate(framePayload);
    this.emit(FrameModelEvents.FrameNavigated, frame);
    this._frameStructureUpdated();
  }

  _frameDetached(cdp: Cdp.Api, frameId: Cdp.Page.FrameId) {
    const frame = this._frames.get(frameId);
    if (!frame)
      return;

    if (frame.parentFrame)
      frame.parentFrame._removeChildFrame(frame);
    else
      frame._remove();
    this._frameStructureUpdated();
  }

  frameForId(frameId: Cdp.Page.FrameId): Frame | undefined {
    return this._frames.get(frameId);
  }

  frames(): Array<Frame> {
    return Array.from(this._frames.values());
  }

  _addFramesRecursively(cdp: Cdp.Api, frameTreePayload: Cdp.Page.FrameResourceTree, parentFrame?: Frame) {
    const framePayload = frameTreePayload.frame;
    let frame = this._frames.get(framePayload.id);
    if (frame) {
      frame._navigate(framePayload);
      this.emit(FrameModelEvents.FrameNavigated, frame);
    } else {
      frame = this._addFrame(cdp, framePayload.id, parentFrame);
      frame._navigate(framePayload);
    }
    for (let i = 0; frameTreePayload.childFrames && i < frameTreePayload.childFrames.length; ++i)
      this._addFramesRecursively(cdp, frameTreePayload.childFrames[i], frame);
  }

  _frameStructureUpdated() {
    const dump = (indent: string, frame: Frame) => {
      for (const child of frame._childFrames.values())
        dump('  ' + indent, child);
    };
    if (this._mainFrame)
      dump('', this._mainFrame);
  }
}

export class Frame {
  readonly cdp: Cdp.Api;
  readonly parentFrame?: Frame;
  readonly id: string;
  readonly model: FrameModel;

  private _url: string;
  private _name: string | undefined;
  private _securityOrigin: string;
  private _unreachableUrl: string;

  _childFrames: Map<Cdp.Page.FrameId, Frame> = new Map();

  constructor(model: FrameModel, cdp: Cdp.Api, frameId: Cdp.Page.FrameId, parentFrame?: Frame) {
    this.cdp = cdp;
    this.model = model;
    this.parentFrame = parentFrame;
    this.id = frameId;
    this._url = '';
    if (this.parentFrame)
      this.parentFrame._childFrames.set(this.id, this);
  }

  _navigate(payload: Cdp.Page.Frame) {
    this._name = payload.name;
    this._url = payload.url;
    this._securityOrigin = payload.securityOrigin;
    this._unreachableUrl = payload.unreachableUrl || '';
    this._removeChildFrames();
  }

  name(): string {
    return this._name || '';
  }

  url(): string {
    return this._url;
  }

  securityOrigin(): string {
    return this._securityOrigin;
  }

  unreachableUrl(): string {
    return this._unreachableUrl;
  }

  isMainFrame(): boolean {
    return !this.parentFrame;
  }

  childFrames(): Frame[] {
    return Array.from(this._childFrames.values());
  }

  _removeChildFrame(frame: Frame) {
    this._childFrames.delete(frame.id);
    frame._remove();
  }

  _removeChildFrames() {
    const frames = Array.from(this._childFrames.values());
    this._childFrames.clear();
    for (let i = 0; i < frames.length; ++i)
      frames[i]._remove();
  }

  _remove() {
    this._removeChildFrames();
    this.model._frames.delete(this.id);
    this.model.emit(FrameModelEvents.FrameDetached, this);
  }

  displayName(): string {
    const icon = '\uD83D\uDCC4 '
    const name = this._name ? this._name + ' - ' : '';
    return icon + name + displayName(this._url);
  }
};

function trimEnd(text: string, maxLength: number) {
  if (text.length <= maxLength)
    return text;
  return text.substr(0, maxLength - 1) + '…';
}

function displayName(urlstring: string): string {
  let url: URL;
  try {
    url = new URL(urlstring);
  } catch (e) {
    return trimEnd(urlstring, 20);
  }

  if (url.protocol === 'data')
    return trimEnd(urlstring, 20);

  if (url.protocol === 'blob')
    return urlstring;
  if (urlstring === 'about:blank')
    return urlstring;

  let displayName = path.basename(url.pathname);
  if (!displayName)
    displayName = (url.host || '') + '/';
  if (displayName === '/')
    displayName = trimEnd(urlstring, 20);
  return displayName;
}
