import * as crypto from 'crypto';
import * as vscode from 'vscode';

export interface RegisterEntry {
  name: string;
  value: string;
}

export interface LedState {
  address: string;
  rawValue?: number;
}

export interface DebugViewSink {
  setRegisters(registers: RegisterEntry[]): void;
  setLeds(leds: LedState): void;
  setMemoryHex(address: string, hexBytes: string): void;
  setMemoryError(address: string, error: string): void;
  getMemoryRequest(): { address: string; byteCount: number };
  clearSession(): void;
}

export interface ViewActionHandler {
  onWriteRegister(name: string, value: string): Promise<void>;
  onReadMemory(address: string): Promise<void>;
  onWriteMemory(address: string, value: string): Promise<void>;
}

const DEFAULT_MEMORY_ADDRESS = '0x00000000';
const DEFAULT_MEMORY_WORDS = 10;
const DEFAULT_MEMORY_BYTES = DEFAULT_MEMORY_WORDS * 4;

const LED_PALETTE = [
  { name: 'Red', color: '#ff4d4f' },
  { name: 'Blue', color: '#3b82f6' },
  { name: 'Green', color: '#22c55e' },
  { name: 'Amber', color: '#f59e0b' },
  { name: 'Cyan', color: '#06b6d4' },
  { name: 'Purple', color: '#a855f7' },
  { name: 'Pink', color: '#ec4899' },
  { name: 'Lime', color: '#84cc16' },
];

/**
 * Webview view rendering CPU registers styled like VS Code Variables with inline editing.
 */
export class QemuRegistersViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private registers: RegisterEntry[] = [];
  private error?: string;

  constructor(private readonly getHandler: () => ViewActionHandler | undefined) {}

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.renderHtml();
    webviewView.webview.onDidReceiveMessage(async (msg) => {
      if (!msg) return;
      if (msg.type === 'ready') {
        this.postState();
        return;
      }
      if (msg.type !== 'writeRegister') return;
      const handler = this.getHandler();
      if (!handler) {
        this.setError('Start debugging and pause target to edit registers.');
        return;
      }
      try {
        this.error = undefined;
        await handler.onWriteRegister(String(msg.name), String(msg.value));
      } catch (err) {
        this.setError(err instanceof Error ? err.message : String(err));
      }
    });
    webviewView.onDidDispose(() => {
      if (this.view === webviewView) this.view = undefined;
    });
    this.postState();
  }

  update(registers: RegisterEntry[]) {
    this.registers = registers;
    this.error = undefined;
    this.postState();
  }

  setError(error: string) {
    this.error = error;
    this.postState();
  }

  private postState() {
    void this.view?.webview.postMessage({
      type: 'state',
      registers: this.registers.map((r) => ({ name: r.name, value: formatHexWord(r.value) })),
      error: this.error,
    });
  }

  private renderHtml(): string {
    const nonce = crypto.randomBytes(16).toString('hex');
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <style>
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
      font-size: 13px;
      user-select: none;
    }
    .error {
      display: none;
      margin: 4px 8px;
      padding: 4px 8px;
      border-radius: 3px;
      font-size: 11px;
      color: var(--vscode-errorForeground);
      background: var(--vscode-inputValidation-errorBackground, rgba(255, 77, 79, 0.12));
      border: 1px solid var(--vscode-inputValidation-errorBorder, #f14c4c);
    }
    .error.visible { display: block; }
    .empty {
      padding: 8px 14px;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }
    .list {
      padding: 2px 0;
    }
    .row {
      display: flex;
      align-items: center;
      height: 22px;
      padding: 0 12px 0 16px;
      gap: 6px;
      cursor: default;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
    }
    .row:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .name {
      color: var(--vscode-debugTokenExpression-name, #9cdcfe);
      white-space: nowrap;
      flex-shrink: 0;
    }
    .name::after {
      content: ':';
      color: var(--vscode-foreground);
    }
    .value {
      color: var(--vscode-debugTokenExpression-number, #b5cea8);
      cursor: text;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      padding: 1px 4px;
      border-radius: 2px;
    }
    .value:hover {
      background: var(--vscode-editor-selectionBackground, rgba(128, 128, 128, 0.2));
    }
    .edit-input {
      flex: 1;
      min-width: 0;
      max-width: 120px;
      height: 19px;
      padding: 0 4px;
      border: 1px solid var(--vscode-focusBorder, #007fd4);
      border-radius: 2px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
      outline: none;
    }
  </style>
</head>
<body>
  <div id="error" class="error"></div>
  <div id="root" class="list"></div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const root = document.getElementById('root');
    const errEl = document.getElementById('error');
    let current = [];
    let editingName = null;

    function render() {
      if (!current.length) {
        root.innerHTML = '<div class="empty">Start debugging and pause target to view registers.</div>';
        return;
      }
      root.innerHTML = '';
      for (const reg of current) {
        const row = document.createElement('div');
        row.className = 'row';
        const parsed = parseInt(reg.value, 16);
        row.title = Number.isNaN(parsed)
          ? reg.name + ': ' + reg.value
          : reg.name + ': ' + reg.value + ' (' + (parsed >>> 0) + ') — click value to edit';

        const nameEl = document.createElement('span');
        nameEl.className = 'name';
        nameEl.textContent = reg.name;
        row.appendChild(nameEl);

        if (editingName === reg.name) {
          const input = document.createElement('input');
          input.className = 'edit-input';
          input.value = reg.value;
          let finished = false;
          const commit = () => {
            if (finished) return;
            finished = true;
            const val = input.value.trim();
            editingName = null;
            if (val && val !== reg.value) {
              vscode.postMessage({ type: 'writeRegister', name: reg.name, value: val });
            }
            render();
          };
          input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
              commit();
            } else if (e.key === 'Escape') {
              finished = true;
              editingName = null;
              render();
            }
          });
          input.addEventListener('blur', commit);
          row.appendChild(input);
          setTimeout(() => { input.focus(); input.select(); }, 0);
        } else {
          const valEl = document.createElement('span');
          valEl.className = 'value';
          valEl.textContent = reg.value;
          valEl.addEventListener('click', () => {
            editingName = reg.name;
            render();
          });
          row.appendChild(valEl);
          row.addEventListener('dblclick', () => {
            editingName = reg.name;
            render();
          });
        }
        root.appendChild(row);
      }
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (!msg || msg.type !== 'state') return;
      if (msg.error) {
        errEl.textContent = msg.error;
        errEl.classList.add('visible');
      } else {
        errEl.classList.remove('visible');
      }
      current = Array.isArray(msg.registers) ? msg.registers : [];
      if (!editingName) render();
    });

    vscode.postMessage({ type: 'ready' });
    render();
  </script>
</body>
</html>`;
  }
}

/**
 * Webview view rendering 10 32-bit words from a chosen address (default 0x00000000) with inline editing.
 */
export class QemuMemoryViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private address = DEFAULT_MEMORY_ADDRESS;
  private rows: Array<{ address: string; wordHex: string; ascii: string }> = [];
  private error?: string;

  constructor(private readonly getHandler: () => ViewActionHandler | undefined) {}

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.renderHtml();
    webviewView.webview.onDidReceiveMessage(async (msg) => {
      if (!msg) return;
      if (msg.type === 'ready') {
        this.postState();
        return;
      }
      const handler = this.getHandler();
      if (msg.type === 'readMemory') {
        const addr = normalizeAddress(String(msg.address || DEFAULT_MEMORY_ADDRESS));
        if (!addr) {
          this.setError(`Invalid address: ${msg.address}`);
          return;
        }
        this.address = addr;
        this.error = undefined;
        if (!handler) {
          this.rows = [];
          this.postState();
          return;
        }
        try {
          await handler.onReadMemory(addr);
        } catch (err) {
          this.setError(err instanceof Error ? err.message : String(err));
        }
      } else if (msg.type === 'writeMemory') {
        if (!handler) {
          this.setError('Start debugging and pause target to edit memory.');
          return;
        }
        try {
          this.error = undefined;
          await handler.onWriteMemory(String(msg.address), String(msg.value));
        } catch (err) {
          this.setError(err instanceof Error ? err.message : String(err));
        }
      }
    });
    webviewView.onDidDispose(() => {
      if (this.view === webviewView) this.view = undefined;
    });
    this.postState();
  }

  getRequest(): { address: string; byteCount: number } {
    return { address: this.address, byteCount: DEFAULT_MEMORY_BYTES };
  }

  setMemoryHex(address: string, hexBytes: string) {
    this.address = address;
    this.error = undefined;
    this.rows = formatMemoryRows(address, hexBytes);
    this.postState();
  }

  setError(error: string) {
    this.error = error;
    this.postState();
  }

  clear() {
    this.rows = [];
    this.error = undefined;
    this.postState();
  }

  private postState() {
    void this.view?.webview.postMessage({
      type: 'state',
      address: this.address,
      rows: this.rows,
      error: this.error,
    });
  }

  private renderHtml(): string {
    const nonce = crypto.randomBytes(16).toString('hex');
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <style>
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
      font-size: 12px;
      user-select: none;
    }
    .bar {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 6px 10px;
      border-bottom: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.2));
    }
    .addr-input {
      flex: 1;
      min-width: 0;
      height: 22px;
      padding: 0 6px;
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 2px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
      outline: none;
    }
    .addr-input:focus {
      border-color: var(--vscode-focusBorder, #007fd4);
    }
    .go-btn {
      height: 22px;
      padding: 0 8px;
      border: none;
      border-radius: 2px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      font-size: 11px;
      cursor: pointer;
    }
    .go-btn:hover {
      background: var(--vscode-button-hoverBackground);
    }
    .error {
      display: none;
      margin: 4px 10px;
      padding: 4px 8px;
      border-radius: 3px;
      font-size: 11px;
      color: var(--vscode-errorForeground);
      background: var(--vscode-inputValidation-errorBackground, rgba(255, 77, 79, 0.12));
      border: 1px solid var(--vscode-inputValidation-errorBorder, #f14c4c);
    }
    .error.visible { display: block; }
    .empty {
      padding: 8px 12px;
      color: var(--vscode-descriptionForeground);
    }
    .list {
      padding: 2px 0;
    }
    .row {
      display: flex;
      align-items: center;
      height: 22px;
      padding: 0 10px;
      gap: 8px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
    }
    .row:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .addr {
      color: var(--vscode-debugTokenExpression-name, #9cdcfe);
      white-space: nowrap;
      flex-shrink: 0;
    }
    .addr::after {
      content: ':';
      color: var(--vscode-foreground);
    }
    .val {
      color: var(--vscode-debugTokenExpression-number, #b5cea8);
      cursor: text;
      padding: 1px 4px;
      border-radius: 2px;
      white-space: nowrap;
    }
    .val:hover {
      background: var(--vscode-editor-selectionBackground, rgba(128, 128, 128, 0.2));
    }
    .ascii {
      color: var(--vscode-descriptionForeground);
      margin-left: auto;
      white-space: pre;
    }
    .edit-input {
      width: 108px;
      height: 19px;
      padding: 0 4px;
      border: 1px solid var(--vscode-focusBorder, #007fd4);
      border-radius: 2px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
      outline: none;
    }
  </style>
</head>
<body>
  <div class="bar">
    <input id="addrInput" class="addr-input" type="text" value="${DEFAULT_MEMORY_ADDRESS}" placeholder="0x00000000" title="Start address (shows 10 words)" />
    <button id="goBtn" class="go-btn">Read</button>
  </div>
  <div id="error" class="error"></div>
  <div id="root" class="list"></div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const addrInput = document.getElementById('addrInput');
    const goBtn = document.getElementById('goBtn');
    const root = document.getElementById('root');
    const errEl = document.getElementById('error');
    let currentRows = [];
    let editingAddr = null;

    function submitAddress() {
      const addr = addrInput.value.trim() || '${DEFAULT_MEMORY_ADDRESS}';
      vscode.postMessage({ type: 'readMemory', address: addr });
    }

    goBtn.addEventListener('click', submitAddress);
    addrInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitAddress();
    });

    function render() {
      if (!currentRows.length) {
        root.innerHTML = '<div class="empty">Start debugging and pause target to view memory.</div>';
        return;
      }
      root.innerHTML = '';
      for (const rowData of currentRows) {
        const row = document.createElement('div');
        row.className = 'row';
        row.title = rowData.address + ': ' + rowData.wordHex + ' — click value to edit';

        const addrEl = document.createElement('span');
        addrEl.className = 'addr';
        addrEl.textContent = rowData.address;
        row.appendChild(addrEl);

        if (editingAddr === rowData.address) {
          const input = document.createElement('input');
          input.className = 'edit-input';
          input.value = rowData.wordHex;
          let finished = false;
          const commit = () => {
            if (finished) return;
            finished = true;
            const val = input.value.trim();
            editingAddr = null;
            if (val && val !== rowData.wordHex) {
              vscode.postMessage({ type: 'writeMemory', address: rowData.address, value: val });
            }
            render();
          };
          input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
              commit();
            } else if (e.key === 'Escape') {
              finished = true;
              editingAddr = null;
              render();
            }
          });
          input.addEventListener('blur', commit);
          row.appendChild(input);
          setTimeout(() => { input.focus(); input.select(); }, 0);
        } else {
          const valEl = document.createElement('span');
          valEl.className = 'val';
          valEl.textContent = rowData.wordHex;
          valEl.addEventListener('click', () => {
            editingAddr = rowData.address;
            render();
          });
          row.appendChild(valEl);
          row.addEventListener('dblclick', () => {
            editingAddr = rowData.address;
            render();
          });
        }

        const asciiEl = document.createElement('span');
        asciiEl.className = 'ascii';
        asciiEl.textContent = rowData.ascii;
        row.appendChild(asciiEl);

        root.appendChild(row);
      }
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (!msg || msg.type !== 'state') return;
      if (msg.address && document.activeElement !== addrInput) {
        addrInput.value = msg.address;
      }
      if (msg.error) {
        errEl.textContent = msg.error;
        errEl.classList.add('visible');
      } else {
        errEl.classList.remove('visible');
      }
      currentRows = Array.isArray(msg.rows) ? msg.rows : [];
      if (!editingAddr) render();
    });

    vscode.postMessage({ type: 'ready' });
    render();
  </script>
</body>
</html>`;
  }
}

/**
 * Webview view rendering 8 differently colored solid LEDs in a single horizontal row.
 */
export class QemuLedsViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private rawValue?: number;

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.renderHtml();
    webviewView.webview.onDidReceiveMessage((msg) => {
      if (msg?.type === 'ready') this.postState();
    });
    webviewView.onDidDispose(() => {
      if (this.view === webviewView) this.view = undefined;
    });
    this.postState();
  }

  update(rawValue?: number) {
    this.rawValue = rawValue;
    this.postState();
  }

  private postState() {
    void this.view?.webview.postMessage({ type: 'leds', rawValue: this.rawValue });
  }

  private renderHtml(): string {
    const nonce = crypto.randomBytes(16).toString('hex');
    const ledsHtml = LED_PALETTE.map((led, i) => {
      const isOn = this.rawValue !== undefined && ((this.rawValue >>> 0) & (1 << i)) !== 0;
      const cls = isOn ? 'led on' : 'led';
      const title = `LED ${i} (${led.name}): ${isOn ? 'ON' : 'OFF'}`;
      return `<span class="${cls}" data-index="${i}" data-name="${led.name}" style="--led:${led.color}" title="${title}"></span>`;
    }).join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <style>
    html, body {
      margin: 0;
      padding: 0;
      background: transparent;
      overflow: hidden;
    }
    .strip {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: nowrap;
      gap: 6px;
      height: 26px;
      padding: 0 12px;
      box-sizing: border-box;
      width: 100%;
    }
    .led {
      width: 14px;
      height: 14px;
      min-width: 10px;
      aspect-ratio: 1;
      border-radius: 50%;
      box-sizing: border-box;
      background: color-mix(in srgb, var(--led) 15%, transparent);
      border: 1.5px solid color-mix(in srgb, var(--led) 45%, transparent);
      transition: background 100ms ease, border-color 100ms ease;
    }
    .led.on {
      background: var(--led);
      border-color: var(--led);
      box-shadow: none;
    }
  </style>
</head>
<body>
  <div class="strip">${ledsHtml}</div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const leds = Array.from(document.querySelectorAll('.led'));
    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (!msg || msg.type !== 'leds') return;
      const val = typeof msg.rawValue === 'number' ? (msg.rawValue >>> 0) : null;
      for (const el of leds) {
        const idx = Number(el.dataset.index);
        const name = el.dataset.name;
        const on = val !== null && ((val & (1 << idx)) !== 0);
        el.classList.toggle('on', on);
        el.title = 'LED ' + idx + ' (' + name + '): ' + (on ? 'ON' : 'OFF');
      }
    });
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}

/**
 * Coordinates the separate Registers, Memory, and LEDs views.
 */
export class QemuDebugViews implements DebugViewSink, vscode.Disposable {
  private actionHandler?: ViewActionHandler;

  readonly registersProvider = new QemuRegistersViewProvider(() => this.actionHandler);
  readonly memoryProvider = new QemuMemoryViewProvider(() => this.actionHandler);
  readonly ledsProvider = new QemuLedsViewProvider();

  setActionHandler(handler?: ViewActionHandler) {
    this.actionHandler = handler;
  }

  setRegisters(registers: RegisterEntry[]) {
    this.registersProvider.update(registers);
  }

  setLeds(leds: LedState) {
    this.ledsProvider.update(leds.rawValue);
  }

  setMemoryHex(address: string, hexBytes: string) {
    this.memoryProvider.setMemoryHex(address, hexBytes);
  }

  setMemoryError(_address: string, error: string) {
    this.memoryProvider.setError(error);
  }

  getMemoryRequest(): { address: string; byteCount: number } {
    return this.memoryProvider.getRequest();
  }

  clearSession() {
    this.registersProvider.update([]);
    this.memoryProvider.clear();
    this.ledsProvider.update(undefined);
  }

  dispose() {}
}

export function normalizeAddress(input: string): string | undefined {
  const num = Number(input.trim());
  if (!Number.isFinite(num) || num < 0) return undefined;
  return `0x${(num >>> 0).toString(16).padStart(8, '0')}`;
}

function formatHexWord(value: string): string {
  if (!value.startsWith('0x') && !value.startsWith('0X')) return value;
  const num = parseInt(value, 16);
  if (Number.isNaN(num)) return value;
  return `0x${(num >>> 0).toString(16).padStart(8, '0')}`;
}

function formatMemoryRows(baseAddress: string, hexBytes: string): Array<{ address: string; wordHex: string; ascii: string }> {
  const base = parseInt(baseAddress, 0) >>> 0;
  const rows: Array<{ address: string; wordHex: string; ascii: string }> = [];
  for (let offset = 0; offset + 8 <= hexBytes.length; offset += 8) {
    const chunk = hexBytes.slice(offset, offset + 8);
    const bytes = chunk.match(/.{2}/g)!.map((b) => parseInt(b, 16));
    const word = ((bytes[3] << 24) | (bytes[2] << 16) | (bytes[1] << 8) | bytes[0]) >>> 0;
    const ascii = bytes.map((b) => (b >= 32 && b <= 126 ? String.fromCharCode(b) : '.')).join('');
    rows.push({
      address: `0x${((base + offset / 2) >>> 0).toString(16).padStart(8, '0')}`,
      wordHex: `0x${word.toString(16).padStart(8, '0')}`,
      ascii,
    });
  }
  return rows;
}
