import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { FullDisassembly, QemuDebugAdapter } from './session';
import { normalizeAddress, QemuDebugViews } from './tree';

const DISASM_SCHEME = 'qemu-disasm';

/**
 * Manages the full mixed source/assembly editor during active debug sessions.
 */
class DisassemblyViewController implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly docChanged = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.docChanged.event;

  private readonly headerDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    fontWeight: 'bold',
    color: new vscode.ThemeColor('debugTokenExpression.name'),
  });
  private readonly sourceOverlayDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    fontStyle: 'italic',
    color: new vscode.ThemeColor('editorCodeLens.foreground'),
  });
  private readonly pcDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('editor.stackFrameHighlightBackground'),
  });
  private readonly cursorSyncDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
  });

  private currentDisasm?: FullDisassembly;
  private currentPcLine?: number;
  private currentCursorLine?: number;
  private readonly subscriptions: vscode.Disposable[];

  constructor(private readonly getActiveAdapter: () => QemuDebugAdapter | undefined) {
    this.subscriptions = [
      vscode.window.onDidChangeTextEditorSelection((e) => {
        this.onSourceSelectionChanged(e);
      }),
      vscode.window.onDidChangeVisibleTextEditors(() => {
        this.applyDecorations();
      }),
    ];
  }

  provideTextDocumentContent(): string {
    return this.currentDisasm?.text || '';
  }

  async syncOnStop(adapter: QemuDebugAdapter) {
    if (!adapter.isDisassemblyEnabled()) return;
    try {
      const disasm = await adapter.getFullDisassembly();
      if (!disasm || !adapter.isStopped()) return;

      const isNew = this.currentDisasm?.elfFile !== disasm.elfFile;
      this.currentDisasm = disasm;
      this.currentCursorLine = undefined;
      const uri = this.uriFor(disasm.elfFile);
      if (isNew) this.docChanged.fire(uri);

      const pc = await adapter.getCurrentPc();
      this.currentPcLine = pc ? disasm.pcToLine.get(pc) : undefined;

      const editor = await this.ensureOpen(uri);
      this.applyDecorations();
      if (editor && this.currentPcLine !== undefined) {
        const pos = new vscode.Position(this.currentPcLine, 0);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      }
    } catch {
      /* Disassembly view is optional; keep normal debug session working. */
    }
  }

  clearRunState() {
    this.currentPcLine = undefined;
    this.currentCursorLine = undefined;
    this.applyDecorations();
  }

  async closeAndClear() {
    this.currentDisasm = undefined;
    this.currentPcLine = undefined;
    this.currentCursorLine = undefined;
    this.applyDecorations();

    for (const group of vscode.window.tabGroups?.all || []) {
      for (const tab of group.tabs) {
        const input = tab.input as { uri?: vscode.Uri } | undefined;
        if (input?.uri?.scheme === DISASM_SCHEME) {
          try {
            await vscode.window.tabGroups.close(tab, true);
          } catch {
            // Ignore close errors if tab already closed
          }
        }
      }
    }
  }

  private onSourceSelectionChanged(e: vscode.TextEditorSelectionChangeEvent) {
    const adapter = this.getActiveAdapter();
    if (!adapter || !adapter.isActive() || !adapter.isDisassemblyEnabled() || !this.currentDisasm) return;
    if (e.textEditor.document.uri.scheme !== 'file') return;

    const disasmEditor = vscode.window.visibleTextEditors.find(
      (ed) => ed.document.uri.scheme === DISASM_SCHEME
    );
    if (!disasmEditor) return;

    const rawPath = path.resolve(e.textEditor.document.uri.fsPath);
    let realPath = rawPath;
    try {
      realPath = fs.realpathSync(rawPath);
    } catch {
      // Keep resolved path
    }
    const baseName = path.basename(rawPath);
    const clickedLine = e.selections[0]?.active.line + 1;
    if (!clickedLine) return;

    const offsets = [0, 1, -1, 2, -2, 3, -3];
    let targetLine: number | undefined;
    for (const offset of offsets) {
      const ln = clickedLine + offset;
      if (ln < 1) continue;
      targetLine =
        this.currentDisasm.sourceToLine.get(`${realPath}:${ln}`) ??
        this.currentDisasm.sourceToLine.get(`${rawPath}:${ln}`) ??
        this.currentDisasm.sourceToLine.get(`${baseName}:${ln}`);
      if (targetLine !== undefined) break;
    }
    if (targetLine === undefined) return;

    this.currentCursorLine = targetLine;
    this.applyDecorations();
    const pos = new vscode.Position(targetLine, 0);
    disasmEditor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  private async ensureOpen(uri: vscode.Uri): Promise<vscode.TextEditor | undefined> {
    const existingEditor = vscode.window.visibleTextEditors.find(
      (ed) => ed.document.uri.scheme === DISASM_SCHEME
    );
    if (existingEditor) return existingEditor;

    let targetColumn = vscode.ViewColumn.Beside;
    for (const group of vscode.window.tabGroups?.all || []) {
      for (const tab of group.tabs) {
        const input = tab.input as { uri?: vscode.Uri } | undefined;
        if (input?.uri?.scheme === DISASM_SCHEME) {
          targetColumn = group.viewColumn;
          break;
        }
      }
    }

    const doc = await vscode.workspace.openTextDocument(uri);
    return vscode.window.showTextDocument(doc, {
      viewColumn: targetColumn,
      preserveFocus: true,
      preview: false,
    });
  }

  private applyDecorations() {
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.scheme !== DISASM_SCHEME) continue;
      if (!this.currentDisasm) {
        editor.setDecorations(this.headerDecoration, []);
        editor.setDecorations(this.sourceOverlayDecoration, []);
        editor.setDecorations(this.pcDecoration, []);
        editor.setDecorations(this.cursorSyncDecoration, []);
        continue;
      }

      const toRanges = (lines: number[]) =>
        lines
          .filter((l) => l >= 0 && l < editor.document.lineCount)
          .map((l) => new vscode.Range(l, 0, l, editor.document.lineAt(l).text.length));

      editor.setDecorations(this.headerDecoration, toRanges(this.currentDisasm.headerLines));
      editor.setDecorations(this.sourceOverlayDecoration, toRanges(this.currentDisasm.sourceLines));
      editor.setDecorations(
        this.pcDecoration,
        this.currentPcLine !== undefined ? toRanges([this.currentPcLine]) : []
      );
      editor.setDecorations(
        this.cursorSyncDecoration,
        this.currentCursorLine !== undefined && this.currentCursorLine !== this.currentPcLine
          ? toRanges([this.currentCursorLine])
          : []
      );
    }
  }

  private uriFor(elfFile: string): vscode.Uri {
    return vscode.Uri.from({
      scheme: DISASM_SCHEME,
      path: `${elfFile}.disasm`,
      query: `${path.basename(elfFile)} [Disassembly]`,
    });
  }

  dispose() {
    void this.closeAndClear();
    for (const s of this.subscriptions) s.dispose();
    this.headerDecoration.dispose();
    this.sourceOverlayDecoration.dispose();
    this.pcDecoration.dispose();
    this.cursorSyncDecoration.dispose();
    this.docChanged.dispose();
  }
}

export function activate(context: vscode.ExtensionContext) {
  const views = new QemuDebugViews();
  let activeAdapter: QemuDebugAdapter | undefined;
  const disasmView = new DisassemblyViewController(() => activeAdapter);

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
    disasmView,
    vscode.workspace.registerTextDocumentContentProvider(DISASM_SCHEME, disasmView),
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
          () => void disasmView.syncOnStop(adapter),
          () => disasmView.clearRunState(),
          () => void disasmView.closeAndClear()
        );
        activeAdapter = adapter;
        return new vscode.DebugAdapterInlineImplementation(adapter);
      },
    }),

    vscode.commands.registerCommand('qemu-m3.refreshViews', async () => {
      if (!activeAdapter) return;
      await activeAdapter.refreshPeripheralViews();
    })
  );
}

export function deactivate() {}
