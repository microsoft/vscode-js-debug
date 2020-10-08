/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { Context, createContext } from 'preact';
import { useContext } from 'preact/hooks';
import { IDiagnosticDump } from '../adapter/diagnosics';

export const DumpContext: Context<IDiagnosticDump | undefined> = createContext<
  IDiagnosticDump | undefined
>(undefined);

export const useDump = () => useContext(DumpContext) as IDiagnosticDump;
