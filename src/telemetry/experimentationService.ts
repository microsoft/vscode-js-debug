/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

export interface IExperiments {
  /**
   * Breakpoint helper prompt
   */
  diagnosticPrompt: boolean;
}

export interface IExperimentationService {
  /**
   * Gets the treatment for the experiment.
   * @param name Name of the experiment
   * @param defaultValue Default to return if the call fails ot no
   * experimentation service is available.
   */
  getTreatment<K extends keyof IExperiments>(
    name: K,
    defaultValue: IExperiments[K],
  ): Promise<IExperiments[K]>;
}

export const IExperimentationService = Symbol('IExperimentationService');
