import * as path from 'path';
import * as vscode from 'vscode';
import { QemuDebugAdapter } from './session';
import { normalizeAddress, QemuDebugViews } from './tree';

/**
 * Ensures the active stack frame's source file stays open on top in the first pane
 * and VS Code's built-in Disassembly View stays open on top in the second pane
 * whenever debugging stops (unless `disassembly: false`), closing Disassembly on end.
 */
class BuiltinDisassemblyController {
  private pending: Promise<void> = Promise.resolve();
  private openCommand?: string;
  private lastSyncedSourceKey?: string;

  onStopped(adapter: QemuDebugAdapter, frameId?: number): Promise<void> {
    this.pending = this.pending
      .catch(() => undefined)
      .then(() => this.ensurePanes(adapter, frameId));
    return this.pending;
  }

  onTerminated(): Promise<void> {
    this.lastSyncedSourceKey = undefined;
    this.pending = this.pending
      .catch(() => undefined)
      .then(() => this.closeDisassemblyTab());
    return this.pending;
  }

  private async ensurePanes(adapter: QemuDebugAdapter, frameId = 0): Promise<void> {
    if (!adapter.isDisassemblyEnabled()) return;

    try {
      const disasmBefore = this.findDisassemblyTab();
      const wasFocusedInDisassembly = Boolean(
        disasmBefore &&
          vscode.window.tabGroups.activeTabGroup === disasmBefore.group &&
          disasmBefore.isActive
      );

      const src = adapter.getSourceLocation(frameId);
      if (src) {
        await this.ensureSourceInFirstPane(adapter.getStopSeq(), frameId, src.path, src.line);
      }

      await this.ensureDisassemblyInSecondPane(wasFocusedInDisassembly);
    } catch {
      /* Built-in Disassembly View remains manually accessible from editor context menu. */
    }
  }

  private async ensureSourceInFirstPane(
    stopSeq: number,
    frameId: number,
    sourcePath: string,
    line: number
  ): Promise<void> {
    if (typeof vscode.window.showTextDocument !== 'function') return;

    const resolvedSource = path.resolve(sourcePath);
    const firstGroup = (vscode.window.tabGroups?.all || []).find(
      (g) => g.viewColumn === vscode.ViewColumn.One
    );
    const existingTab = firstGroup?.tabs.find((tab) => {
      const input = tab.input as { uri?: vscode.Uri } | undefined;
      return Boolean(input?.uri?.fsPath && path.resolve(input.uri.fsPath) === resolvedSource);
    });

    const line0 = Math.max(0, line - 1);
    const key = `${stopSeq}:${frameId}:${resolvedSource}:${line0}`;
    if (existingTab?.isActive && this.lastSyncedSourceKey === key) {
      return;
    }

    this.lastSyncedSourceKey = key;
    const selection = new vscode.Range(line0, 0, line0, 0);
    await vscode.window.showTextDocument(vscode.Uri.file(sourcePath), {
      viewColumn: vscode.ViewColumn.One,
      preserveFocus: true,
      preview: false,
      selection,
    });
  }

  private async ensureDisassemblyInSecondPane(preserveDisassemblyFocus: boolean): Promise<void> {
    const existing = this.findDisassemblyTab();

    // Fast path: already open in the second pane and currently on top.
    if (existing && existing.group.viewColumn === vscode.ViewColumn.Two && existing.isActive) {
      return;
    }

    const openCmd = await this.resolveOpenCommand();

    if (
      existing &&
      existing.group.viewColumn !== vscode.ViewColumn.Two &&
      existing.group.viewColumn !== vscode.ViewColumn.One
    ) {
      // Present in a 3rd+ pane -> close so we re-open cleanly in the second pane.
      await vscode.window.tabGroups.close(existing, true);
    }

    const moveFromFirstGroup = existing?.group.viewColumn === vscode.ViewColumn.One;
    const hasSecondGroup = (vscode.window.tabGroups?.all || []).some(
      (g) => g.viewColumn === vscode.ViewColumn.Two
    );

    if (!moveFromFirstGroup && hasSecondGroup) {
      await vscode.commands.executeCommand('workbench.action.focusSecondEditorGroup');
      await vscode.commands.executeCommand(openCmd);
    } else {
      await vscode.commands.executeCommand(openCmd);
      await vscode.commands.executeCommand('workbench.action.moveEditorToNextGroup');
    }

    if (!preserveDisassemblyFocus) {
      await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');
    }
  }

  private async closeDisassemblyTab(): Promise<void> {
    const tab = this.findDisassemblyTab();
    if (!tab) return;
    try {
      await vscode.window.tabGroups.close(tab, true);
    } catch {
      // Ignore if already closed
    }
  }

  private async resolveOpenCommand(): Promise<string> {
    if (this.openCommand) return this.openCommand;
    try {
      const cmds = await vscode.commands.getCommands(true);
      if (cmds.includes('debug.action.openDisassemblyView')) {
        this.openCommand = 'debug.action.openDisassemblyView';
      } else if (cmds.includes('editor.debug.action.openDisassemblyView')) {
        this.openCommand = 'editor.debug.action.openDisassemblyView';
      }
    } catch {
      // Fall back to standard VS Code command id
    }
    return this.openCommand ?? 'debug.action.openDisassemblyView';
  }

  private findDisassemblyTab(): vscode.Tab | undefined {
    for (const group of vscode.window.tabGroups?.all || []) {
      for (const tab of group.tabs) {
        const input = tab.input as { uri?: vscode.Uri } | undefined;
        if (input?.uri?.scheme === 'disassembly' || tab.label === 'Disassembly') {
          return tab;
        }
      }
    }
    return undefined;
  }
}

export function activate(context: vscode.ExtensionContext) {
  const views = new QemuDebugViews();
  const disassembly = new BuiltinDisassemblyController();
  let activeAdapter: QemuDebugAdapter | undefined;

  views.setActionHandler({
    onWriteRegister: async (name, value) => {
      if (!activeAdapter) throw new Error('No active QEMU debug session.');
      await activeAdapter.writeRegister(name, value);
    },
    onReadMemory: async (address) => {
      if (!activeAdapter) throw new Error('No active QEMU debug session.');
      const addr = normalizeAddress(address);
      if (!addr) throw new Error(`Invalid address: ${address}`);
      await activeAdapter.readMemoryToView(addr);
    },
    onWriteMemory: async (address, value) => {
      if (!activeAdapter) throw new Error('No active QEMU debug session.');
      const parsed = Number(value.trim());
      if (!Number.isFinite(parsed)) throw new Error(`Invalid value: ${value}`);
      await activeAdapter.writeMemoryWord(address, parsed >>> 0);
    },
  });

  context.subscriptions.push(
    views,
    vscode.window.registerWebviewViewProvider('qemu-m3.registersView', views.registersProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider('qemu-m3.memoryView', views.memoryProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),

    vscode.debug.registerDebugAdapterDescriptorFactory('qemu-m3', {
      createDebugAdapterDescriptor: () => {
        let adapter!: QemuDebugAdapter;
        adapter = new QemuDebugAdapter(
          views,
          () => {
            if (activeAdapter === adapter) activeAdapter = undefined;
          },
          () => void disassembly.onStopped(adapter),
          () => void disassembly.onTerminated()
        );
        activeAdapter = adapter;
        return new vscode.DebugAdapterInlineImplementation(adapter);
      },
    }),

    vscode.debug.onDidChangeActiveStackItem((item) => {
      if (!activeAdapter || !item || !('frameId' in item)) return;
      if (item.session.type !== 'qemu-m3') return;
      void disassembly.onStopped(activeAdapter, item.frameId);
    }),

    vscode.commands.registerCommand('qemu-m3.refreshViews', async () => {
      if (!activeAdapter) return;
      await activeAdapter.refreshPeripheralViews();
    })
  );
}

export function deactivate() { }
