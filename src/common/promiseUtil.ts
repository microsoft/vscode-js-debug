/**
 * Returns a promise that resolves after the given time.
 */
export const delay = (duration: number) => new Promise<void>(resolve => setTimeout(resolve, duration));
