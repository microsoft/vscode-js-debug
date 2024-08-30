/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { IBenchmarkApi } from '@c4312/matcha';
import { formatMessage } from '../../adapter/messageFormat';
import { messageFormatters } from '../../adapter/objectPreview';

export default function(api: IBenchmarkApi) {
  api.bench('simple', () => {
    formatMessage(
      '',
      [{ type: 'number', value: 1234, description: '1234', subtype: undefined }],
      messageFormatters,
    );
  });
}
