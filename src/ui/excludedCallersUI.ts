/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { createHash } from 'crypto';
import { inject, injectable } from 'inversify';
import { basename } from 'path';
import * as vscode from 'vscode';
import {
  Commands,
  ContextKey,
  CustomViews,
  registerCommand,
  setContextKey,
} from '../common/contributionUtils';
import type Dap from '../dap/api';
import { IExtensionContribution } from '../ioc-extras';
import { DebugSessionTracker } from './debugSessionTracker';

interface ICallerWithName extends Dap.CallerLocation {
  name: string;
}

const locationLabel = ({ name, line, column, source }: ICallerWithName) =>
  `${name} (${basename(String(source.path))}:${line}:${column})`;

const fullLabel = ({ name, line, column, source }: ICallerWithName) =>
  `${name} (${source.path}:${line}:${column})`;

const revealLocation = async ({ line, column, source }: Dap.CallerLocation) => {
  if (source.sourceReference !== 0 || !source.path) {
    return;
  }

  const uri = vscode.Uri.file(source.path);
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc);
  const position = new vscode.Position(line - 1, column - 1);
  editor.revealRange(new vscode.Range(position, position));
  editor.selection = new vscode.Selection(position, position);
};

export class ExcludedCaller {
  public readonly treeItem: vscode.TreeItem;
  public readonly id: string;

  constructor(public readonly caller: ICallerWithName, public readonly target: ICallerWithName) {
    this.treeItem = new vscode.TreeItem(
      `${locationLabel(caller)} → ${locationLabel(target)}`,
      vscode.TreeItemCollapsibleState.None,
    );

    this.treeItem.tooltip = `Breaks at ${fullLabel(target)} containing ${
      fullLabel(
        caller,
      )
    } will be skipped`;

    this.id = this.treeItem.id = createHash('sha256')
      .update(JSON.stringify([caller, target]))
      .digest('base64');
  }

  public toDap(): Dap.ExcludedCaller {
    return {
      caller: this.caller,
      target: this.target,
    };
  }
}

@injectable()
export class ExcludedCallersUI
  implements vscode.TreeDataProvider<ExcludedCaller>, IExtensionContribution
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<ExcludedCaller | undefined>();
  private allCallers = new Map<string, ExcludedCaller>();
  private lastHadCallers = false;

  constructor(
    @inject(DebugSessionTracker) private readonly sessionTracker: DebugSessionTracker,
  ) {}

  /** @inheritdoc */
  register(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      vscode.window.createTreeView(CustomViews.ExcludedCallers, {
        treeDataProvider: this,
      }),
      registerCommand(vscode.commands, Commands.CallersAdd, async (_uri, context) => {
        const stack = await this.sessionTracker
          .getById(context.sessionId)
          ?.customRequest('stackTrace', {
            threadId: 0, // js-debug doesn't do threads, so ID is always 0
            startFrame: 0,
            levels: 1,
          });

        if (!stack?.stackFrames.length) {
          return;
        }

        const topOfStack = stack.stackFrames[0];
        const caller = new ExcludedCaller(
          {
            name: context.frameName,
            column: context.frameLocation.range.startColumn,
            line: context.frameLocation.range.startLineNumber,
            source: context.frameLocation.source,
          },
          {
            name: topOfStack.name,
            column: topOfStack.column,
            line: topOfStack.line,
            source: topOfStack.source,
          },
        );

        this.allCallers.set(caller.id, caller);
        this.triggerUpdate();
      }),
      registerCommand(vscode.commands, Commands.CallersGoToCaller, c => revealLocation(c.caller)),
      registerCommand(vscode.commands, Commands.CallersGoToTarget, c => revealLocation(c.target)),
      registerCommand(vscode.commands, Commands.CallersRemove, async c => {
        this.allCallers.delete(c.id);
        this.triggerUpdate();
      }),
      registerCommand(vscode.commands, Commands.CallersRemoveAll, () => {
        this.allCallers.clear();
        this.triggerUpdate();
      }),
      this.sessionTracker.onSessionAdded(e => {
        if (this.allCallers.size > 0) {
          this.sendCallersToSession(e);
        }
      }),
    );
  }

  /** @inheritdoc */
  public readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /** @inheritdoc */
  getTreeItem(element: ExcludedCaller): vscode.TreeItem {
    return element.treeItem;
  }

  /** @inheritdoc */
  getChildren(element?: ExcludedCaller): ExcludedCaller[] {
    return element ? [] : [...this.allCallers.values()];
  }

  private sendCallersToSession(session: vscode.DebugSession) {
    session.customRequest('setExcludedCallers', {
      callers: [...this.allCallers.values()].map(c => c.toDap()),
    });
  }

  private triggerUpdate() {
    this._onDidChangeTreeData.fire(undefined);

    for (const session of this.sessionTracker.getConcreteSessions()) {
      this.sendCallersToSession(session);
    }

    const hasCallers = this.allCallers.size > 0;
    if (hasCallers !== this.lastHadCallers) {
      setContextKey(vscode.commands, ContextKey.HasExcludedCallers, hasCallers);
      this.lastHadCallers = hasCallers;
    }
  }
}
