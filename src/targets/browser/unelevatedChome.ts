/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import Dap from '../../dap/api';
import { promiseTimeout } from '../../int-chrome/testUtils';

export async function launchUnelevatedChrome(
  dap: Dap.Api,
  chromePath: string,
  chromeArgs: string[],
): Promise<number> {
  const response: any = (dap as any).launchUnelevatedRequest({
    process: chromePath,
    args: chromeArgs,
  });

  return (await promiseTimeout(response, 10000 /* 10 seconds */)).processId;
}
