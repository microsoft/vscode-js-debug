/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import Cdp from '../cdp/api';

export interface IXHRBreakpoint {
  match: string;
}

export interface ICustomBreakpoint {
  id: string;
  title: string;
  group: string;
  details: (data: object) => { short: string; long: string };
  apply: (cdp: Cdp.Api, enabled: boolean) => Promise<boolean>;
}

const map: Map<string, ICustomBreakpoint> = new Map();

export function customBreakpoints(): Map<string, ICustomBreakpoint> {
  if (map.size) return map;

  function g(group: string, breakpoints: ICustomBreakpoint[]) {
    for (const b of breakpoints) {
      b.group = group;
      map.set(b.id, b);
    }
  }

  function i(instrumentation: string, maybeTitle?: string): ICustomBreakpoint {
    const title = maybeTitle || instrumentation;
    return {
      id: 'instrumentation:' + instrumentation,
      title,
      group: '',
      // eslint-disable-next-line
      details: (data: any): { short: string; long: string } => {
        if (instrumentation === 'webglErrorFired') {
          let errorName = data['webglErrorName'];
          // If there is a hex code of the error, display only this.
          errorName = errorName.replace(/^.*(0x[0-9a-f]+).*$/i, '$1');
          return {
            short: errorName,
            long: l10n.t(
              'Paused on WebGL Error instrumentation breakpoint, error "{0}"',
              errorName,
            ),
          };
        }
        if (instrumentation === 'scriptBlockedByCSP' && data['directiveText']) {
          return {
            short: l10n.t('CSP violation "{0}"', data['directiveText']),
            long: l10n.t(
              'Paused on Content Security Policy violation instrumentation breakpoint, directive "{0}"',
              data['directiveText'],
            ),
          };
        }
        return {
          short: title,
          long: l10n.t('Paused on instrumentation breakpoint "{0}"', title),
        };
      },
      apply: async (cdp: Cdp.Api, enabled: boolean): Promise<boolean> => {
        // DOMDebugger.setInstrumentationBreakpoint was very recently deprecated,
        // try the old method as a fallback.
        const ok1 = enabled
          ? await cdp.EventBreakpoints.setInstrumentationBreakpoint({
            eventName: instrumentation,
          })
          : await cdp.EventBreakpoints.removeInstrumentationBreakpoint({
            eventName: instrumentation,
          });

        if (ok1) {
          return true;
        }

        const ok2 = enabled
          ? await cdp.DOMDebugger.setInstrumentationBreakpoint({ eventName: instrumentation })
          : await cdp.DOMDebugger.removeInstrumentationBreakpoint({
            eventName: instrumentation,
          });

        return !!ok2;
      },
    };
  }

  function e(eventName: string, target?: string | string[], title?: string): ICustomBreakpoint {
    const eventTargets = target === undefined
      ? '*'
      : typeof target === 'string'
      ? [target]
      : target;
    return {
      id: 'listener:' + eventName,
      title: title || eventName,
      group: '',
      details: (data: { targetName?: string }): { short: string; long: string } => {
        const eventTargetName = (data.targetName || '*').toLowerCase();
        return {
          short: eventTargetName + '.' + eventName,
          long: l10n.t(
            'Paused on event listener breakpoint "{0}", triggered on "{1}"',
            eventName,
            eventTargetName,
          ),
        };
      },
      apply: async (cdp: Cdp.Api, enabled: boolean): Promise<boolean> => {
        let result = true;
        for (const eventTarget of eventTargets) {
          if (enabled) {
            result = result
              && !!(await cdp.DOMDebugger.setEventListenerBreakpoint({
                eventName,
                targetName: eventTarget,
              }));
          } else {
            result = result
              && !!(await cdp.DOMDebugger.removeEventListenerBreakpoint({
                eventName,
                targetName: eventTarget,
              }));
          }
        }
        return result;
      },
    };
  }

  g(`Ad Auction Worklet`, [
    i('beforeBidderWorkletBiddingStart', l10n.t('Bidder Bidding Phase Start')),
    i('beforeBidderWorkletReportingStart', l10n.t('Bidder Reporting Phase Start')),
    i('beforeSellerWorkletScoringStart', l10n.t('Seller Scoring Phase Start')),
    i('beforeSellerWorkletReportingStart', l10n.t('Seller Reporting Phase Start')),
  ]);
  g(`Animation`, [
    i('requestAnimationFrame', l10n.t('Request Animation Frame')),
    i('cancelAnimationFrame', l10n.t('Cancel Animation Frame')),
    i('requestAnimationFrame.callback', l10n.t('Animation Frame Fired')),
  ]);
  g(`Canvas`, [
    i('canvasContextCreated', l10n.t('Create canvas context')),
    i('webglErrorFired', l10n.t('WebGL Error Fired')),
    i('webglWarningFired', l10n.t('WebGL Warning Fired')),
  ]);
  g(`Clipboard`, [
    e('copy'),
    e('cut'),
    e('paste'),
    e('beforecopy'),
    e('beforecut'),
    e('beforepaste'),
  ]);
  g(`Control`, [
    e('resize'),
    e('scroll'),
    e('scrollend'),
    e('zoom'),
    e('focus'),
    e('blur'),
    e('select'),
    e('change'),
    e('submit'),
    e('reset'),
  ]);
  g(`Device`, [e('deviceorientation'), e('devicemotion')]);
  g(`DOM Mutation`, [
    e('DOMActivate'),
    e('DOMFocusIn'),
    e('DOMFocusOut'),
    e('DOMAttrModified'),
    e('DOMCharacterDataModified'),
    e('DOMNodeInserted'),
    e('DOMNodeInsertedIntoDocument'),
    e('DOMNodeRemoved'),
    e('DOMNodeRemovedFromDocument'),
    e('DOMSubtreeModified'),
    e('DOMContentLoaded'),
  ]);
  g(`Drag / Drop`, [
    e('drag'),
    e('dragstart'),
    e('dragend'),
    e('dragenter'),
    e('dragover'),
    e('dragleave'),
    e('drop'),
  ]);
  g(`Geolocation`, [
    i('Geolocation.getCurrentPosition', `getCurrentPosition`),
    i('Geolocation.watchPosition', `watchPosition`),
  ]);
  g(`Keyboard`, [e('keydown'), e('keyup'), e('keypress'), e('input')]);
  g(`Load`, [
    e('load'),
    e('beforeunload'),
    e('unload'),
    e('abort'),
    e('error'),
    e('hashchange'),
    e('popstate'),
    e('navigate'),
    e('navigatesuccess'),
    e('navigateerror'),
    e('currentchange'),
    e('nagivateto'),
    e('navigatefrom'),
    e('finish'),
    e('dispose'),
  ]);
  const av = ['audio', 'video'];
  g(`Media`, [
    e('play', av),
    e('pause', av),
    e('playing', av),
    e('canplay', av),
    e('canplaythrough', av),
    e('seeking', av),
    e('seeked', av),
    e('timeupdate', av),
    e('ended', av),
    e('ratechange', av),
    e('durationchange', av),
    e('volumechange', av),
    e('loadstart', av),
    e('progress', av),
    e('suspend', av),
    e('abort', av),
    e('error', av),
    e('emptied', av),
    e('stalled', av),
    e('loadedmetadata', av),
    e('loadeddata', av),
    e('waiting', av),
  ]);
  g(`Mouse`, [
    e('auxclick'),
    e('click'),
    e('dblclick'),
    e('mousedown'),
    e('mouseup'),
    e('mouseover'),
    e('mousemove'),
    e('mouseout'),
    e('mouseenter'),
    e('mouseleave'),
    e('mousewheel'),
    e('wheel'),
    e('contextmenu'),
  ]);
  g(`Notification`, [i('Notification.requestPermission', `requestPermission`)]);
  g(`Parse`, [
    i('Element.setInnerHTML', l10n.t('Set innerHTML')),
    i('Document.write', `document.write`),
  ]);
  g(`Picture-in-Picture`, [
    e('enterpictureinpicture', 'video'),
    e('leavepictureinpicture', 'video'),
    e('resize', 'PictureInPictureWindow'),
    e('enter', 'documentPictureInPicture'),
  ]);
  g(`Pointer`, [
    e('pointerover'),
    e('pointerout'),
    e('pointerenter'),
    e('pointerleave'),
    e('pointerdown'),
    e('pointerup'),
    e('pointermove'),
    e('pointercancel'),
    e('gotpointercapture'),
    e('lostpointercapture'),
    e('pointerrawupdate'),
  ]);
  g(`Script`, [
    i('scriptFirstStatement', l10n.t('Script First Statement')),
    i('scriptBlockedByCSP', l10n.t('Script Blocked by Content Security Policy')),
  ]);
  g(`Timer`, [
    i('setTimeout'),
    i('clearTimeout'),
    i('setInterval'),
    i('clearInterval'),
    i('setTimeout.callback', l10n.t('setTimeout fired')),
    i('setInterval.callback', l10n.t('setInterval fired')),
  ]);
  g(`Touch`, [e('touchstart'), e('touchmove'), e('touchend'), e('touchcancel')]);
  g(`WebAudio`, [
    i('audioContextCreated', l10n.t('Create AudioContext')),
    i('audioContextClosed', l10n.t('Close AudioContext')),
    i('audioContextResumed', l10n.t('Resume AudioContext')),
    i('audioContextSuspended', l10n.t('Suspend AudioContext')),
  ]);
  g(`Window`, [i('DOMWindow.close', `window.close`)]);
  g(`Worker`, [e('message'), e('messageerror')]);
  const xhr = ['xmlhttprequest', 'xmlhttprequestupload'];
  g(`XHR`, [
    e('readystatechange', xhr),
    e('load', xhr),
    e('loadstart', xhr),
    e('loadend', xhr),
    e('abort', xhr),
    e('error', xhr),
    e('progress', xhr),
    e('timeout', xhr),
  ]);

  return map;
}

export default customBreakpoints;
