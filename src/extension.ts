import * as vscode from 'vscode';
import { QemuDebugAdapter } from './session';

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('qemu-m3', { createDebugAdapterDescriptor: () => new vscode.DebugAdapterInlineImplementation(new QemuDebugAdapter()) }));
}
export function deactivate() {}
