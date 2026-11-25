import * as vscode from 'vscode';
import { QemuDebugAdapter } from './session';
import { normalizeAddress, QemuDebugViews } from './tree';

export function activate(context: vscode.ExtensionContext) {
  const views = new QemuDebugViews();
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
    vscode.window.registerWebviewViewProvider('qemu-m3.ledsView', views.ledsProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),

    vscode.debug.registerDebugAdapterDescriptorFactory('qemu-m3', {
      createDebugAdapterDescriptor: () => {
        const adapter = new QemuDebugAdapter(views, () => {
          if (activeAdapter === adapter) activeAdapter = undefined;
        });
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
