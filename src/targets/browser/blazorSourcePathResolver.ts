/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import path from 'path';
import { IVueFileMapper } from '../../adapter/vueFileMapper';
import { IFsUtils } from '../../common/fsUtils';
import { ILogger, LogTag } from '../../common/logging';
import * as utils from '../../common/urlUtils';
import { BrowserSourcePathResolver, IOptions } from './browserPathResolver';

export class BlazorSourcePathResolver extends BrowserSourcePathResolver {
  private readonly blazorInCodespacesRegexp: RegExp;
  private readonly blazorInCodespacesRegexpSubstitution = '$1:\\$2';

  constructor(vueMapper: IVueFileMapper, fsUtils: IFsUtils, options: IOptions, logger: ILogger) {
    super(vueMapper, fsUtils, options, logger);
    if (this.options.remoteFilePrefix) {
      const sep = `\\${path.sep}`;
      const escapedPrefix = this.options.remoteFilePrefix.replace(new RegExp(sep, 'g'), sep);
      this.blazorInCodespacesRegexp = new RegExp(
        `^${escapedPrefix}${sep}([A-z])\\$${sep}(.*)$`,
        // Sample value: /^C:\\Users\\digeff\\AppData\\Local\\Temp\\4169355D62D44D791D2A7534DE8994AB4B9E\\9\\~~\\([A-z])\$\\(.*)$/
      );
    } else {
      this.blazorInCodespacesRegexp = new RegExp('');
    }
  }

  public absolutePathToUrlRegexp(absolutePath: string) {
    if (this.options.remoteFilePrefix) {
      // Sample values:
      // absolutePath = C:\\Users\\digeff\\AppData\\Local\\Temp\\97D4F6178D8AD3159C555FA5FACA1ABA807E\\7\\~~\\C$\\workspace\\BlazorApp\\Pages\\Counter.razor
      const filePath = absolutePath.replace(
        this.blazorInCodespacesRegexp,
        this.blazorInCodespacesRegexpSubstitution,
      );
      // filePath = C:\\workspace\\BlazorApp\\Pages\\Counter.razor
      const fileUrlPath = utils.platformPathToUrlPath(filePath);
      // fileUrlPath = C:/workspace/BlazorApp/Pages/Counter.razor
      const noColonFileUrlPath = fileUrlPath.replace(/^(\w):(.*)$/, '$1$2');
      // noColonFileUrlPath = C/workspace/BlazorApp/Pages/Counter.razor
      const fileRegexp = utils.urlToRegex(noColonFileUrlPath);
      // fileRegexp = [cC]\\/[wW][oO][rR][kK][sS][pP][aA][cC][eE]\\/[bB][lL][aA][zZ][oO][rR][wW][aA][sS][mM]\\/[pP][aA][gG][eE][sS]\\/[cC][oO][uU][nN][tT][eE][rR]\\.[rR][aA][zZ][oO][rR]
      if (fileRegexp) {
        const dotnetUrlRegexp = `dotnet://.*\\.dll/${fileRegexp}`;
        // dotnetUrlRegexp = dotnet://.*\\.dll/[cC]\\/[wW][oO][rR][kK][sS][pP][aA][cC][eE]\\/[bB][lL][aA][zZ][oO][rR][wW][aA][sS][mM]\\/[pP][aA][gG][eE][sS]\\/[cC][oO][uU][nN][tT][eE][rR]\\.[rR][aA][zZ][oO][rR]
        this.logger.verbose(LogTag.RuntimeBreakpoints, 'absolutePathToUrlRegexp.blazor.remoteFs', {
          absolutePath,
          dotnetUrlRegexp,
        });
        return dotnetUrlRegexp;
      }
    } else {
      // Blazor files have a file:/// url. Override the default absolutePathToUrlRegexp which returns an http based regexp
      const fileUrl = utils.absolutePathToFileUrl(absolutePath);
      const fileRegexp = utils.urlToRegex(fileUrl);
      const fileRegexpSuper = super.absolutePathToUrlRegexp(absolutePath);
      if (!fileRegexp.includes(fileRegexpSuper)) return `${fileRegexp}|${fileRegexpSuper}`;
      return fileRegexp;
    }

    return super.absolutePathToUrlRegexp(absolutePath);
  }
}
