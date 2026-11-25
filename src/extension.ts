import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { QemuDebugAdapter } from './session';
import { normalizeAddress, QemuDebugViews } from './tree';

const ASM_SCHEME = 'qemu-asm';

class SourceAssemblyDecorations
  implements vscode.CodeLensProvider, vscode.TextDocumentContentProvider, vscode.Disposable
{
  private groups: Awaited<ReturnType<QemuDebugAdapter['getMixedSourceAssembly']>> = [];
  private readonly expanded = new Map<string, Set<number>>();
  private readonly lensesChanged = new vscode.EventEmitter<void>();
  private readonly docChanged = new vscode.EventEmitter<vscode.Uri>();
  private readonly pcLineDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('editor.stackFrameHighlightBackground'),
  });
  private readonly asmLineDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    color: new vscode.ThemeColor('editorCodeLens.foreground'),
  });

  readonly onDidChangeCodeLenses = this.lensesChanged.event;
  readonly onDidChange = this.docChanged.event;

  async refresh(adapter: QemuDebugAdapter) {
    try {
      this.groups = await adapter.getMixedSourceAssembly();
      this.lensesChanged.fire();
      for (const file of this.expanded.keys()) {
        const asmUri = this.asmUriFor(file);
        this.docChanged.fire(asmUri);
      }
      this.applyAsmDecorations();
    } catch {
      /* Source mapping is optional; retain normal debug behavior. */
    }
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (document.uri.scheme === ASM_SCHEME) return [];
    const openLines = this.expanded.get(document.uri.fsPath);
    return this.groups
      .filter((item) => item.file === document.uri.fsPath && item.line <= document.lineCount)
      .map((item) => {
        const isExpanded = openLines?.has(item.line) ?? false;
        return new vscode.CodeLens(new vscode.Range(item.line - 1, 0, item.line - 1, 0), {
          title: isExpanded ? '▾' : '▸',
          command: 'qemu-m3.toggleAssembly',
          arguments: [document.uri, item.line],
          tooltip: isExpanded ? 'Hide disassembly' : 'Show disassembly',
        });
      });
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const filePath = uri.fsPath;
    const openDoc = vscode.workspace.textDocuments.find(
      (d) => d.uri.scheme === 'file' && d.uri.fsPath === filePath
    );
    const rawText = openDoc ? openDoc.getText() : fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
    const srcLines = rawText.split(/\r?\n/);
    const width = Math.max(2, String(srcLines.length).length);
    const expandedLines = this.expanded.get(filePath) || new Set<number>();
    const byLine = new Map<number, (typeof this.groups)[number]>();
    for (const g of this.groups) {
      if (g.file === filePath) byLine.set(g.line, g);
    }

    const out: string[] = [];
    for (let i = 0; i < srcLines.length; i++) {
      const lineNo = i + 1;
      const lineText = srcLines[i];
      out.push(`${String(lineNo).padStart(width)} | ${lineText}`);

      if (expandedLines.has(lineNo)) {
        const group = byLine.get(lineNo);
        if (group) {
          const indent = lineText.match(/^\s*/)?.[0] || '';
          const pad = ' '.repeat(width);
          for (const inst of group.instructions) {
            const mark = inst.address === group.pc ? '▶' : ' ';
            out.push(`${pad} | ${indent}\t${mark} ${inst.address}  ${inst.instruction}`);
          }
        }
      }
    }
    return out.join('\n');
  }

  async toggle(uri: vscode.Uri, line: number) {
    const filePath = uri.fsPath;
    let lines = this.expanded.get(filePath);
    if (!lines) {
      lines = new Set<number>();
      this.expanded.set(filePath, lines);
    }
    if (lines.has(line)) {
      lines.delete(line);
      if (lines.size === 0) this.expanded.delete(filePath);
    } else {
      lines.add(line);
    }

    this.lensesChanged.fire();
    const asmUri = this.asmUriFor(filePath);
    this.docChanged.fire(asmUri);

    if (lines.has(line)) {
      const doc = await vscode.workspace.openTextDocument(asmUri);
      const editor = await vscode.window.showTextDocument(doc, {
        viewColumn: vscode.ViewColumn.Beside,
        preserveFocus: true,
        preview: true,
      });
      const targetRow = this.findRenderedLine(doc, line);
      if (targetRow >= 0) {
        const pos = new vscode.Position(targetRow, 0);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      }
      this.applyAsmDecorations();
    } else {
      this.applyAsmDecorations();
    }
  }

  private applyAsmDecorations() {
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.scheme !== ASM_SCHEME) continue;
      const pcRanges: vscode.Range[] = [];
      const asmRanges: vscode.Range[] = [];
      for (let i = 0; i < editor.document.lineCount; i++) {
        const text = editor.document.lineAt(i).text;
        if (/^\s+\|\s+▶\s+0x[0-9a-fA-F]+/.test(text)) {
          pcRanges.push(new vscode.Range(i, 0, i, text.length));
        } else if (/^\s+\|\s+0x[0-9a-fA-F]+/.test(text)) {
          asmRanges.push(new vscode.Range(i, 0, i, text.length));
        }
      }
      editor.setDecorations(this.pcLineDecoration, pcRanges);
      editor.setDecorations(this.asmLineDecoration, asmRanges);
    }
  }

  private findRenderedLine(doc: vscode.TextDocument, sourceLine: number): number {
    const prefix = new RegExp(`^\\s*${sourceLine}\\s\\|`);
    for (let i = 0; i < doc.lineCount; i++) {
      if (prefix.test(doc.lineAt(i).text)) return i;
    }
    return -1;
  }

  private asmUriFor(filePath: string): vscode.Uri {
    return vscode.Uri.from({
      scheme: ASM_SCHEME,
      path: filePath,
      query: `${path.basename(filePath)} [Assembly]`,
    });
  }

  clear() {
    this.groups = [];
    this.expanded.clear();
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.scheme === ASM_SCHEME) {
        editor.setDecorations(this.pcLineDecoration, []);
        editor.setDecorations(this.asmLineDecoration, []);
      }
    }
    this.lensesChanged.fire();
  }

  dispose() {
    this.clear();
    this.pcLineDecoration.dispose();
    this.asmLineDecoration.dispose();
    this.lensesChanged.dispose();
    this.docChanged.dispose();
  }
}

export function activate(context: vscode.ExtensionContext) {
  const views = new QemuDebugViews();
  const assembly = new SourceAssemblyDecorations();
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
    assembly,
    vscode.workspace.registerTextDocumentContentProvider(ASM_SCHEME, assembly),
    vscode.languages.registerCodeLensProvider(
      [{ language: 'c' }, { language: 'cpp' }, { language: 'asm' }, { language: 'assembly' }],
      assembly
    ),
    vscode.window.registerWebviewViewProvider('qemu-m3.registersView', views.registersProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider('qemu-m3.memoryView', views.memoryProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider('qemu-m3.ledsView', views.ledsProvider, {
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
          () => void assembly.refresh(adapter),
          () => assembly.clear()
        );
        activeAdapter = adapter;
        return new vscode.DebugAdapterInlineImplementation(adapter);
      },
    }),

    vscode.commands.registerCommand('qemu-m3.refreshViews', async () => {
      if (!activeAdapter) return;
      await activeAdapter.refreshPeripheralViews();
    }),
    vscode.commands.registerCommand('qemu-m3.toggleAssembly', (uri: vscode.Uri, line: number) =>
      assembly.toggle(uri, line)
    )
  );
}

export function deactivate() {}
