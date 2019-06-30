// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import Cdp from "../cdp/api";

export interface CustomBreakpoint {
  id: string;
  title: string;
  group: string;
  details: (data: object) => {short: string, long: string};
  apply: (cdp: Cdp.Api, enabled: boolean) => Promise<boolean>;
};

export const customBreakpoints: Map<string, CustomBreakpoint> = new Map();

function g(group: string, breakpoints: CustomBreakpoint[]) {
  for (const b of breakpoints) {
    b.group = group;
    customBreakpoints.set(b.id, b);
  }
}

function i(instrumentation: string, maybeTitle?: string): CustomBreakpoint {
  const title = maybeTitle || instrumentation;
  return {
    id: 'instrumentation:' + instrumentation,
    title,
    group: '',
    details: (data: object): {short: string, long: string} => {
      if (instrumentation === 'webglErrorFired') {
        let errorName = data['webglErrorName'];
        // If there is a hex code of the error, display only this.
        errorName = errorName.replace(/^.*(0x[0-9a-f]+).*$/i, '$1');
        return {
          short: `WebGL Error '${errorName}'`,
          long: `Paused on WebGL Error instrumentation breakpoint, error '${errorName}'`
        };
      }
      if (instrumentation === 'scriptBlockedByCSP' && data['directiveText']) {
        return {
          short: `CSP violation '${data['directiveText']}'`,
          long: `Paused on Content Security Policy violation instrumentation breakpoint, directive '${data['directiveText']}'`
        };
      }
      return {
        short: title,
        long: `Paused on instrumentation breakpoint '${title}'`
      };
    },
    apply: async (cdp: Cdp.Api, enabled: boolean): Promise<boolean> => {
      if (enabled)
        return !!await cdp.DOMDebugger.setInstrumentationBreakpoint({eventName: instrumentation!});
      else
        return !!await cdp.DOMDebugger.removeInstrumentationBreakpoint({eventName: instrumentation!});
    }
  };
}

function e(eventName: string, target?: string | string[], title?: string): CustomBreakpoint {
  const eventTargets = target === undefined ? '*' : (typeof target === 'string' ? [target] : target);
  return {
    id: 'listener:' + eventName,
    title: title || eventName,
    group: '',
    details: (data: object): {short: string, long: string} => {
      const eventTargetName = (data['targetName'] || '*').toLowerCase();
      return {
        short: eventTargetName + '.' + eventName,
        long: `Paused on event listener breakpoint '${eventName}', triggered on '${eventTargetName}'`
      };
    },
    apply: async (cdp: Cdp.Api, enabled: boolean): Promise<boolean> => {
      let result = true;
      for (const eventTarget of eventTargets) {
        if (enabled)
          result = result && !!await cdp.DOMDebugger.setEventListenerBreakpoint({eventName, targetName: eventTarget});
        else
          result = result && !!await cdp.DOMDebugger.removeEventListenerBreakpoint({eventName, targetName: eventTarget});
      }
      return result;
    }
  };
}

g(`Animation`, [
  i('requestAnimationFrame', `Request Animation Frame`),
  i('cancelAnimationFrame', `Cancel Animation Frame`),
  i('requestAnimationFrame.callback', `Animation Frame Fired`),
]);
g(`Canvas`, [
  i('canvasContextCreated', `Create canvas context`),
  i('webglErrorFired', `WebGL Error Fired`),
  i('webglWarningFired', `WebGL Warning Fired`),
]);
g(`Script`, [
  i('scriptFirstStatement', `Script First Statement`),
  i('scriptBlockedByCSP', `Script Blocked by Content Security Policy`)
]);
g(`Geolocation`, [
  i('Geolocation.getCurrentPosition', `getCurrentPosition`),
  i('Geolocation.watchPosition', `watchPosition`),
]);
g(`Notification`, [
  i('Notification.requestPermission', `requestPermission`),
]);
g(`Parse`, [
  i('Element.setInnerHTML', `Set innerHTML`),
  i('Document.write', `document.write`),
]);
g(`Timer`, [
  i('setTimeout'),
  i('clearTimeout'),
  i('setInterval'),
  i('clearInterval'),
  i('setTimeout.callback', `setTimeout fired`),
  i('setInterval.callback', `setInterval fired`),
]);
g(`Window`, [
  i('DOMWindow.close', `window.close`),
]);
g(`WebAudio`, [
  i('audioContextCreated', `Create AudioContext`),
  i('audioContextClosed', `Close AudioContext`),
  i('audioContextResumed', `Resume AudioContext`),
  i('audioContextSuspended', `Suspend AudioContext`),
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
  e('waiting', av)
]);
g(`Picture-in-Picture`, [
  e('enterpictureinpicture', 'video'),
  e('leavepictureinpicture', 'video'),
  e('resize', 'PictureInPictureWindow'),
]);
g(`Clipboard`, [
  e('copy'),
  e('cut'),
  e('paste'),
  e('beforecopy'),
  e('beforecut'),
  e('beforepaste')
]);
g(`Control`, [
  e('resize'),
  e('scroll'),
  e('zoom'),
  e('focus'),
  e('blur'),
  e('select'),
  e('change'),
  e('submit'),
  e('reset')
]);
g(`Device`, [
  e('deviceorientation'),
  e('devicemotion')
]);
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
  e('DOMContentLoaded')
]);
g(`Drag / drop`, [
  e('drag'),
  e('dragstart'),
  e('dragend'),
  e('dragenter'),
  e('dragover'),
  e('dragleave'),
  e('drop')
]);
g(`Keyboard`, [
  e('keydown'),
  e('keyup'),
  e('keypress'),
  e('input')
]);
g(`Load`, [
  e('load'),
  e('beforeunload'),
  e('unload'),
  e('abort'),
  e('error'),
  e('hashchange'),
  e('popstate')
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
  e('contextmenu')
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
  e('lostpointercapture')
]);
g(`Touch`, [
  e('touchstart'),
  e('touchmove'),
  e('touchend'),
  e('touchcancel')
]);
g(`Worker`, [
  e('message'),
  e('messageerror')
]);
const xhr = ['xmlhttprequest', 'xmlhttprequestupload'];
g(`XHR`, [
  e('readystatechange', xhr),
  e('load', xhr),
  e('loadstart', xhr),
  e('loadend', xhr),
  e('abort', xhr),
  e('error', xhr),
  e('progress', xhr),
  e('timeout', xhr)
]);
