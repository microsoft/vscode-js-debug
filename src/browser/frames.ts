// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import Cdp from '../cdp/api';
import { URL } from 'url';
import * as path from 'path';
import * as vscode from 'vscode';

export class FrameModel {
  private _mainFrame?: Frame;
  private _onFrameAddedEmitter = new vscode.EventEmitter<Frame>();
  _onFrameRemovedEmitter = new vscode.EventEmitter<Frame>();
  private _onFrameNavigatedEmitter = new vscode.EventEmitter<Frame>();

  readonly onFrameAdded = this._onFrameAddedEmitter.event;
  readonly onFrameRemoved = this._onFrameRemovedEmitter.event;
  readonly onFrameNavigated = this._onFrameNavigatedEmitter.event;

  _frames: Map<string, Frame> = new Map();

  attached(cdp: Cdp.Api) {
    cdp.Page.enable({});
    cdp.Page.getResourceTree({}).then(result => {
      this._processCachedResources(cdp, result ? result.frameTree : undefined);
    })
  }

  mainFrame(): Frame | undefined {
    return this._mainFrame;
  }

  _processCachedResources(cdp: Cdp.Api, mainFramePayload?: Cdp.Page.FrameResourceTree) {
    if (mainFramePayload)
      this._addFramesRecursively(cdp, mainFramePayload, mainFramePayload.frame.parentId);
    cdp.Page.on('frameAttached', event => {
      this._frameAttached(cdp, event.frameId, event.parentFrameId);
    });
    cdp.Page.on('frameNavigated', event => {
      this._frameNavigated(cdp, event.frame);
    });
    cdp.Page.on('frameDetached', event => {
      this._frameDetached(cdp, event.frameId);
    });
  }

  _addFrame(cdp: Cdp.Api, frameId: Cdp.Page.FrameId, parentFrameId?: Cdp.Page.FrameId): Frame {
    const frame = new Frame(this, cdp, frameId, parentFrameId);
    this._frames.set(frame.id, frame);
    if (frame.isMainFrame())
      this._mainFrame = frame;
    this._onFrameAddedEmitter.fire(frame);
    return frame;
  }

  _frameAttached(cdp: Cdp.Api, frameId: Cdp.Page.FrameId, parentFrameId?: Cdp.Page.FrameId): Frame | undefined {
    if (this._frames.has(frameId))
      return;

    const frame = this._addFrame(cdp, frameId, parentFrameId);
    return frame;
  }

  _frameNavigated(cdp: Cdp.Api, framePayload: Cdp.Page.Frame) {
    let frame: Frame | undefined = this._frames.get(framePayload.id);
    if (!frame) {
      // Simulate missed "frameAttached" for a main frame navigation to the new backend process.
      frame = this._frameAttached(cdp, framePayload.id, framePayload.parentId || '') as Frame;
      console.assert(frame);
    }

    frame._navigate(framePayload);
    this._onFrameNavigatedEmitter.fire(frame);
  }

  _frameDetached(cdp: Cdp.Api, frameId: Cdp.Page.FrameId) {
    const frame = this._frames.get(frameId);
    if (!frame)
      return;
    frame._remove();
  }

  frameForId(frameId: Cdp.Page.FrameId): Frame | undefined {
    return this._frames.get(frameId);
  }

  frames(): Array<Frame> {
    return Array.from(this._frames.values());
  }

  _addFramesRecursively(cdp: Cdp.Api, frameTreePayload: Cdp.Page.FrameResourceTree, parentFrameId?: Cdp.Page.FrameId) {
    const framePayload = frameTreePayload.frame;
    let frame = this._frames.get(framePayload.id);
    if (frame) {
      frame._navigate(framePayload);
      this._onFrameNavigatedEmitter.fire(frame);
    } else {
      frame = this._addFrame(cdp, framePayload.id, parentFrameId);
      frame._navigate(framePayload);
    }
    for (let i = 0; frameTreePayload.childFrames && i < frameTreePayload.childFrames.length; ++i)
      this._addFramesRecursively(cdp, frameTreePayload.childFrames[i], frame.id);
  }
}

export class Frame {
  readonly cdp: Cdp.Api;
  readonly id: Cdp.Page.FrameId;
  readonly model: FrameModel;

  private _url: string;
  private _name: string | undefined;
  private _securityOrigin: string | undefined;
  private _unreachableUrl: string | undefined;
  private _parentFrameId?: Cdp.Page.FrameId;

  constructor(model: FrameModel, cdp: Cdp.Api, frameId: Cdp.Page.FrameId, parentFrameId?: Cdp.Page.FrameId) {
    this.cdp = cdp;
    this.model = model;
    this._parentFrameId = parentFrameId;
    this.id = frameId;
    this._url = '';
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

  securityOrigin(): string | undefined {
    return this._securityOrigin;
  }

  unreachableUrl(): string | undefined {
    return this._unreachableUrl;
  }

  isMainFrame(): boolean {
    return !this._parentFrameId;
  }

  parentFrame(): Frame | undefined {
    return this._parentFrameId ? this.model.frameForId(this._parentFrameId) : undefined;
  }

  childFrames(): Frame[] {
    return this.model.frames().filter(frame => frame._parentFrameId === this.id);
  }

  _removeChildFrames() {
    for (const child of this.childFrames())
      child._remove();
  }

  _remove() {
    this._removeChildFrames();
    this.model._frames.delete(this.id);
    this.model._onFrameRemovedEmitter.fire(this);
  }

  displayName(): string {
    const name = this._name ? this._name + ' - ' : '';
    const dname = name + displayName(this._url);
    return dname || '<iframe>';
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
