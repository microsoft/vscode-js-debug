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
  FrameWillNavigate: Symbol('FrameWillNavigate'),
  InspectedURLChanged: Symbol('InspectedURLChanged'),
  MainFrameNavigated: Symbol('MainFrameNavigated'),
};

export class FrameModel extends EventEmitter {
  private _cdp: Cdp.Api;
  private _cachedResourcesProcessed = false;
  private _mainFrame: Frame | null = null;

  _frames: Map<string, Frame> = new Map();
  _parentModel: FrameModel | undefined;

  constructor(cdp: Cdp.Api, parentModel: FrameModel | undefined) {
    super();
    this._cdp = cdp;
    this._parentModel = parentModel;
    this._cdp.Page.enable({});
    this._cdp.Page.getResourceTree({}).then(r => {
      if (r)
        this._processCachedResources(r.frameTree);
    });

    this._cdp.Page.on('frameAttached', event => {
      this._frameAttached(event.frameId, event.parentFrameId);
    });
    this._cdp.Page.on('frameNavigated', event => {
      this._frameNavigated(event.frame);
    });
    this._cdp.Page.on('frameDetached', event => {
      this._frameDetached(event.frameId);
    });
  }

  _processCachedResources(mainFramePayload: Cdp.Page.FrameResourceTree | null) {
    if (mainFramePayload) {
      this._addFramesRecursively(null, mainFramePayload);
      this.emit(FrameModelEvents.InspectedURLChanged, mainFramePayload.frame.url);
    }
    this._cachedResourcesProcessed = true;
  }

  _addFrame(frame: Frame, aboutToNavigate?: boolean) {
    this._frames.set(frame.id, frame);
    if (frame.isMainFrame())
      this._mainFrame = frame;
    this.emit(FrameModelEvents.FrameAdded, frame);
  }

  _frameAttached(frameId: Cdp.Page.FrameId, parentFrameId: Cdp.Page.FrameId | null): Frame | null {
    const parentFrame = parentFrameId ? (this._frames.get(parentFrameId) || null) : null;
    // Do nothing unless cached resource tree is processed - it will overwrite everything.
    if (!this._cachedResourcesProcessed && parentFrame)
      return null;
    if (this._frames.has(frameId))
      return null;

    const frame = new Frame(this, parentFrame, frameId, null);
    if (parentFrameId && !parentFrame)
      frame._crossTargetParentFrameId = parentFrameId;
    if (frame.isMainFrame() && this._mainFrame) {
      // Navigation to the new backend process.
      this._frameDetached(this._mainFrame.id);
    }
    this._addFrame(frame, true);
    return frame;
  }

  _frameNavigated(framePayload: Cdp.Page.Frame) {
    const parentFrame = framePayload.parentId ? (this._frames.get(framePayload.parentId) || null) : null;
    // Do nothing unless cached resource tree is processed - it will overwrite everything.
    if (!this._cachedResourcesProcessed && parentFrame)
      return;
    let frame: Frame | null = this._frames.get(framePayload.id) || null;
    if (!frame) {
      // Simulate missed "frameAttached" for a main frame navigation to the new backend process.
      frame = this._frameAttached(framePayload.id, framePayload.parentId || '') as Frame;
      console.assert(frame);
    }

    this.emit(FrameModelEvents.FrameWillNavigate, frame);
    frame._navigate(framePayload);
    this.emit(FrameModelEvents.FrameNavigated, frame);

    if (frame.isMainFrame())
      this.emit(FrameModelEvents.MainFrameNavigated, frame);

    if (frame.isMainFrame())
      this.emit(FrameModelEvents.InspectedURLChanged, frame.url);
  }

  _frameDetached(frameId: Cdp.Page.FrameId) {
    // Do nothing unless cached resource tree is processed - it will overwrite everything.
    if (!this._cachedResourcesProcessed)
      return;

    const frame = this._frames.get(frameId);
    if (!frame)
      return;

    if (frame.parentFrame)
      frame.parentFrame._removeChildFrame(frame);
    else
      frame._remove();
  }

  frameForId(frameId: Cdp.Page.FrameId): Frame | undefined {
    return this._frames.get(frameId);
  }

  frames(): Array<Frame> {
    return Array.from(this._frames.values());
  }

  _addFramesRecursively(parentFrame: Frame | null, frameTreePayload: Cdp.Page.FrameResourceTree) {
    const framePayload = frameTreePayload.frame;
    const frame = new Frame(this, parentFrame, framePayload.id, framePayload);
    if (!parentFrame && framePayload.parentId)
      frame._crossTargetParentFrameId = framePayload.parentId;
    this._addFrame(frame);

    for (let i = 0; frameTreePayload.childFrames && i < frameTreePayload.childFrames.length; ++i)
      this._addFramesRecursively(frame, frameTreePayload.childFrames[i]);
  }
}

class Frame {
  _crossTargetParentFrameId: string | null;
  readonly parentFrame: Frame | null;
  readonly childFrames: Frame[] = [];
  readonly id: string;
  private _model: FrameModel;
  private _url: string;
  private _name: string | undefined;
  private _securityOrigin: string;
  private _unreachableUrl: string;

  constructor(model: FrameModel, parentFrame: Frame | null, frameId: Cdp.Page.FrameId, payload: Cdp.Page.Frame | null) {
    this._model = model;
    this.parentFrame = parentFrame;
    this.id = frameId;
    this._url = '';
    this._crossTargetParentFrameId = null;

    if (payload) {
      this._name = payload.name;
      this._url = payload.url;
      this._securityOrigin = payload.securityOrigin;
      this._unreachableUrl = payload.unreachableUrl || '';
    }

    if (this.parentFrame)
      this.parentFrame.childFrames.push(this);
  }


  _navigate(framePayload: Cdp.Page.Frame) {
    this._name = framePayload.name;
    this._url = framePayload.url;
    this._securityOrigin = framePayload.securityOrigin;
    this._unreachableUrl = framePayload.unreachableUrl || '';
    this._removeChildFrames();
  }

  frameModel(): FrameModel {
    return this._model;
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

  crossTargetParentFrame(): Frame | null {
    if (!this._crossTargetParentFrameId)
      return null;
    if (!this._model._parentModel)
      return null;
    // Note that parent model has already processed cached resources:
    // - when parent target was created, we issued getResourceTree call;
    // - strictly after we issued setAutoAttach call;
    // - both of them were handled in renderer in the same order;
    // - cached resource tree got processed on parent model;
    // - child target was created as a result of setAutoAttach call.
    return this._model._parentModel.frameForId(this._crossTargetParentFrameId) || null;
  }

  isMainFrame(): boolean {
    return !this.parentFrame;
  }

  isTopFrame() {
    return !this.parentFrame && !this._crossTargetParentFrameId;
  }

  _removeChildFrame(frame: Frame) {
    const index = this.childFrames.indexOf(frame);
    if (index !== -1)
      this.childFrames.splice(index, 1);
    frame._remove();
  }

  _removeChildFrames() {
    const frames = this.childFrames.slice();
    this.childFrames.length = 0;
    for (let i = 0; i < frames.length; ++i)
      frames[i]._remove();
  }

  _remove() {
    this._removeChildFrames();
    this._model._frames.delete(this.id);
    this._model.emit(FrameModelEvents.FrameDetached, this);
  }

  displayName(): string {
    if (this.isTopFrame())
      return 'top';
    const subtitle = displayName(this._url);
    if (subtitle) {
      if (!this._name)
        return subtitle;
      return this._name + ' (' + subtitle + ')';
    }
    return '<iframe>';
  }
};

function trimEnd(text: string, maxLength: number) {
  if (text.length <= maxLength)
    return text;
  return text.substr(0, maxLength - 1) + '…';
}

function displayName(urlstring: string): string {
  const url = new URL(urlstring);
  if (!url)
    return trimEnd(urlstring, 20);

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
