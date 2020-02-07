/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

export const ITargetOrigin = Symbol('ITargetOrigin');

/**
 * The target origin is the debug session ID (a GUID/UUID) in DAP which is
 * a parent to this session.
 */
export interface ITargetOrigin {
  readonly id: string;
}

/**
 * Immutable implementation of ITargetOrigin.
 */
export class TargetOrigin implements ITargetOrigin {
  constructor(public readonly id: string) {}
}

/**
 * A mutable version of ITargetOrigin. Used in the {@link DelegateLauncher}.
 */
export class MutableTargetOrigin implements ITargetOrigin {
  constructor(public id: string) {}
}
