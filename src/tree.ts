import * as vscode from 'vscode';
export class QemuTreeProvider implements vscode.TreeDataProvider<TreeItem> {
  private changed = new vscode.EventEmitter<TreeItem | undefined>(); readonly onDidChangeTreeData = this.changed.event;
  status = 'Disconnected'; watches: string[] = []; memory = ''; leds = 0;
  getTreeItem(item: TreeItem) { return item; }
  getChildren(item?: TreeItem) { if (!item) return ['Target','Registers','Watch','Breakpoints','Memory','LEDs'].map(x => new TreeItem(x, true)); const d: Record<string,string[]> = { Target: [`${this.status} · mps2-an385`], Registers: ['r0 —','r1 —','r2 —','r3 —','r4 —','r5 —','r6 —','r7 —','r8 —','r9 —','r10 —','r11 —','r12 —','r13 —','r14 —','r15 —','xpsr —','control —','primask —','faultmask —','basepri —'], Watch: this.watches.length ? this.watches : ['No expressions'], Breakpoints: ['No breakpoints'], Memory: this.memory ? [this.memory] : ['Use “Read Memory”'], LEDs: [...Array(8)].map((_, i) => `LED${i} ${this.leds & (1 << i) ? '●' : '○'}`) }; return (d[item.label] || []).map(x => new TreeItem(x)); }
  addWatch(x: string) { this.watches.push(x); this.changed.fire(undefined); }
  async readMemory() { const a = await vscode.window.showInputBox({ prompt: 'Start address', value: '0x40028000' }); if (a) { this.memory = `${a}: target memory will be read when stopped`; this.changed.fire(undefined); } }
  writeMemory() { vscode.window.showInformationMessage('Memory writes require a stopped target.'); }
}
class TreeItem extends vscode.TreeItem { constructor(public readonly label: string, expandable = false) { super(label, expandable ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None); } }
