import * as events from 'events';

type HandlerFunction = (...args: any[]) => void;

interface Listener {
   emitter: events.EventEmitter;
   eventName: string;
   handler: HandlerFunction;
}

export function addEventListener(emitter: events.EventEmitter, eventName: string, handler: HandlerFunction): Listener {
	emitter.on(eventName, handler);
	return { emitter, eventName, handler };
}

export function removeEventListeners(listeners: Listener[]) {
	for (const listener of listeners)
		listener.emitter.removeListener(listener.eventName, listener.handler);
	listeners.splice(0, listeners.length);
}
