import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import treeKill = require('tree-kill');
import { MIObject, MIParser, MIRecord, MIValue } from './mi';
import { DebugViewSink, RegisterEntry } from './tree';

type Config = vscode.DebugConfiguration & {
  elfFile?: string;
  qemuPath?: string;
  gdbPath?: string;
  gdbPort?: number;
  machine?: string;
  buildCommand?: string;
  ledRegister?: string;
  stopOnEntry?: boolean;
};

interface DAPRequest {
  seq: number;
  type: string;
  command: string;
  arguments?: any;
}

export interface SourceAssemblyLine {
  file: string;
  line: number;
  instructions: Array<{ address: string; instruction: string }>;
  pc: string;
}

const LOCALS_SCOPE_REF = 1;

/**
 * Debug Adapter for QEMU Cortex-M3 targets driven over GDB/MI2.
 */
export class QemuDebugAdapter implements vscode.DebugAdapter {
  private readonly emitter = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
  readonly onDidSendMessage = this.emitter.event;

  private gdb?: cp.ChildProcessWithoutNullStreams;
  private qemu?: cp.ChildProcess;
  private qmpSocket?: net.Socket;
  private qmpTimer?: NodeJS.Timeout;
  private lastLedValue?: number;
  private parser = new MIParser();
  private seq = 1;
  private token = 1;
  private pending = new Map<number, { resolve: (r: MIRecord) => void; reject: (err: Error) => void }>();
  private cfg!: Config;
  private root = process.cwd();
  private status: 'Disconnected' | 'Building' | 'Attaching' | 'Running' | 'Stopped' = 'Disconnected';
  private suppressStopped = false;
  private stopWaiters: Array<() => void> = [];
  private breakpointsByFile = new Map<string, number[]>();
  private registerNames: string[] = [];
  private activeFrameId = 0;
  private terminated = false;
  private disposed = false;

  constructor(
    private readonly views?: DebugViewSink,
    private readonly onDispose?: () => void,
    private readonly onStopped?: () => void,
    private readonly onResumed?: () => void
  ) {}

  handleMessage(message: vscode.DebugProtocolMessage) {
    const req = message as DAPRequest;
    if (req.type === 'request') void this.request(req);
  }

  dispose() {
    this.disposed = true;
    this.end();
    this.onDispose?.();
    this.emitter.dispose();
  }

  private send(type: string, payload: Record<string, any> = {}) {
    if (this.disposed) return;
    this.emitter.fire({ type, seq: this.seq++, ...payload } as unknown as vscode.DebugProtocolMessage);
  }

  private sendEvent(event: string, body?: Record<string, any>) {
    this.send('event', body ? { event, body } : { event });
  }

  private reply(m: DAPRequest, body: Record<string, any> = {}) {
    this.send('response', { request_seq: m.seq, success: true, command: m.command, body });
  }

  private logOutput(text: string, category: 'stdout' | 'stderr' | 'console' = 'console') {
    if (!text) return;
    this.sendEvent('output', { category, output: text });
  }

  private async request(m: DAPRequest) {
    try {
      switch (m.command) {
        case 'initialize':
          this.reply(m, {
            supportsConfigurationDoneRequest: true,
            supportsEvaluateForHovers: true,
            supportsDisassembleRequest: true,
            supportsSteppingGranularity: true,
          });
          break;
        case 'launch':
          this.cfg = m.arguments;
          await this.start(false);
          this.reply(m);
          this.sendEvent('initialized');
          break;
        case 'attach':
          this.cfg = m.arguments;
          await this.start(true);
          this.reply(m);
          this.sendEvent('initialized');
          break;
        case 'configurationDone':
          this.reply(m);
          if (this.cfg.stopOnEntry === false) {
            await this.mi('exec-continue');
            this.status = 'Running';
          } else {
            this.stop('entry');
          }
          break;
        case 'disconnect':
          this.reply(m);
          this.end();
          break;
        case 'threads':
          this.reply(m, { threads: [{ id: 1, name: 'Cortex-M3' }] });
          break;
        case 'continue':
          await this.mi('exec-continue');
          this.status = 'Running';
          this.onResumed?.();
          this.reply(m, { allThreadsContinued: true });
          break;
        case 'pause':
          this.interruptTarget();
          this.reply(m);
          break;
        case 'next': {
          const cmd = m.arguments?.granularity === 'instruction' ? 'exec-next-instruction' : 'exec-next';
          await this.mi(cmd);
          this.status = 'Running';
          this.onResumed?.();
          this.reply(m);
          break;
        }
        case 'stepIn': {
          const cmd = m.arguments?.granularity === 'instruction' ? 'exec-step-instruction' : 'exec-step';
          await this.mi(cmd);
          this.status = 'Running';
          this.onResumed?.();
          this.reply(m);
          break;
        }
        case 'stepOut':
          await this.mi('exec-finish');
          this.status = 'Running';
          this.onResumed?.();
          this.reply(m);
          break;
        case 'setBreakpoints':
          await this.handleSetBreakpoints(m);
          break;
        case 'stackTrace':
          await this.handleStackTrace(m);
          break;
        case 'scopes':
          this.activeFrameId = m.arguments?.frameId ?? 0;
          this.reply(m, {
            scopes: [
              { name: 'Locals', variablesReference: LOCALS_SCOPE_REF, expensive: false },
            ],
          });
          break;
        case 'variables':
          await this.handleVariables(m);
          break;
        case 'evaluate':
          await this.handleEvaluate(m);
          break;
        case 'disassemble':
          await this.handleDisassemble(m);
          break;
        default:
          this.reply(m);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logOutput(`${msg}\n`, 'stderr');
      this.send('response', {
        request_seq: m.seq,
        success: false,
        command: m.command,
        message: msg,
      });
    }
  }

  private async start(attach: boolean) {
    this.terminated = false;
    this.root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
    const resolve = (s?: string) => s?.replace(/\$\{workspaceFolder\}/g, this.root);

    this.cfg.elfFile = resolve(this.cfg.elfFile);
    this.cfg.qemuPath = resolve(this.cfg.qemuPath) || this.findBinary('qemu-system-arm');
    this.cfg.gdbPath = resolve(this.cfg.gdbPath) || this.findBinary('arm-none-eabi-gdb');
    this.cfg.gdbPort ||= 3333;
    this.cfg.machine ||= 'mps2-an385';

    const env = this.buildEnv();
    this.views?.setLeds({ address: this.cfg.ledRegister || '0x40028000' });

    if (!attach && this.cfg.buildCommand) {
      this.status = 'Building';
      const cmd = resolve(this.cfg.buildCommand)!;
      this.logOutput(`Building: ${cmd}\n`, 'console');
      await this.runBuild(cmd, env);
    }

    if (this.cfg.elfFile && !fs.existsSync(this.cfg.elfFile)) {
      throw new Error(`ELF file not found: ${this.cfg.elfFile}`);
    }

    if (!attach) {
      const qmpPort = await this.findFreePort().catch(() => undefined);
      const qemuArgs = [
        '-M', this.cfg.machine,
        '-cpu', 'cortex-m3',
        '-display', 'none',
        '-serial', 'null',
        '-monitor', 'none',
        '-S',
        '-gdb', `tcp:127.0.0.1:${this.cfg.gdbPort}`,
      ];
      if (qmpPort) {
        qemuArgs.push('-qmp', `tcp:127.0.0.1:${qmpPort},server,nowait`);
      }
      if (this.cfg.elfFile) {
        qemuArgs.push('-kernel', this.cfg.elfFile);
      }
      await this.spawnQemu(this.cfg.qemuPath, qemuArgs, env);
      if (qmpPort) {
        this.startQmpLedMonitor(qmpPort);
      }
    } else {
      this.status = 'Attaching';
    }

    this.spawnGdb(this.cfg.gdbPath, env);
    this.suppressStopped = true;
    try {
      if (this.cfg.elfFile) {
        await this.mi(`file-exec-and-symbols "${this.escapeMI(this.cfg.elfFile)}"`);
      }
      await this.mi(`target-select remote 127.0.0.1:${this.cfg.gdbPort}`);
    } finally {
      this.suppressStopped = false;
    }

    this.status = 'Stopped';
  }

  private buildEnv(): NodeJS.ProcessEnv {
    const extraDirs = ['/opt/homebrew/bin', '/usr/local/bin'];
    for (const bin of [this.cfg.qemuPath, this.cfg.gdbPath]) {
      if (bin && path.isAbsolute(bin)) extraDirs.push(path.dirname(bin));
    }
    const existing = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
    const merged = [...new Set([...extraDirs, ...existing])];
    return { ...process.env, PATH: merged.join(path.delimiter) };
  }

  private findBinary(name: string): string {
    for (const dir of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
    return name;
  }

  private runBuild(command: string, env: NodeJS.ProcessEnv): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = cp.exec(command, { cwd: this.root, env }, (err) => {
        if (err) reject(new Error(`Build failed: ${err.message}`));
        else resolve();
      });
      proc.stdout?.on('data', (d) => this.logOutput(d.toString(), 'stdout'));
      proc.stderr?.on('data', (d) => this.logOutput(d.toString(), 'stderr'));
    });
  }

  private spawnQemu(qemuPath: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let stderrBuf = '';
      const qemu = cp.spawn(qemuPath, args, { cwd: this.root, env, stdio: ['ignore', 'pipe', 'pipe'] });
      this.qemu = qemu;

      qemu.stdout?.on('data', (d) => this.logOutput(d.toString(), 'stdout'));
      qemu.stderr?.on('data', (d) => {
        const text = d.toString();
        stderrBuf += text;
        this.logOutput(text, 'stderr');
      });
      qemu.on('error', (err) => {
        if (!settled) {
          settled = true;
          reject(new Error(`Failed to start QEMU (${qemuPath}): ${err.message}`));
        }
      });
      qemu.on('exit', (code, signal) => {
        if (!settled) {
          settled = true;
          const detail = stderrBuf.trim() || `code=${code} signal=${signal}`;
          reject(new Error(`QEMU exited unexpectedly: ${detail}`));
        } else if (!this.terminated) {
          this.logOutput(`QEMU exited (${code ?? signal})\n`, 'stderr');
          this.end();
        }
      });

      this.waitForPort(this.cfg.gdbPort!, 5000)
        .then(() => {
          if (!settled) {
            settled = true;
            resolve();
          }
        })
        .catch((err) => {
          if (!settled) {
            settled = true;
            reject(err);
          }
        });
    });
  }

  private waitForPort(port: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
      const attempt = () => {
        if (!this.qemu || this.qemu.exitCode !== null) {
          reject(new Error('QEMU terminated before opening GDB port.'));
          return;
        }
        const sock = net.createConnection({ host: '127.0.0.1', port });
        sock.once('connect', () => {
          sock.destroy();
          resolve();
        });
        sock.once('error', () => {
          sock.destroy();
          if (Date.now() >= deadline) {
            reject(new Error(`Timed out waiting for QEMU GDB server on port ${port}.`));
          } else {
            setTimeout(attempt, 50);
          }
        });
      };
      attempt();
    });
  }

  private spawnGdb(gdbPath: string, env: NodeJS.ProcessEnv) {
    const gdb = cp.spawn(gdbPath, ['--quiet', '--nx', '--interpreter=mi2'], { cwd: this.root, env });
    this.gdb = gdb;
    gdb.stdout.on('data', (d) => this.onMI(d.toString()));
    gdb.stderr.on('data', (d) => this.logOutput(d.toString(), 'stderr'));
    gdb.on('error', (err) => {
      this.rejectAllPending(new Error(`Failed to start GDB (${gdbPath}): ${err.message}`));
    });
    gdb.on('exit', (code, signal) => {
      this.rejectAllPending(new Error(`GDB exited (${code ?? signal})`));
      if (!this.terminated) this.end();
    });
  }

  private rejectAllPending(err: Error) {
    for (const [, waiter] of this.pending) waiter.reject(err);
    this.pending.clear();
  }

  private onMI(text: string) {
    for (const r of this.parser.feed(text)) {
      if (r.kind === 'result' && r.token && this.pending.has(r.token)) {
        const waiter = this.pending.get(r.token)!;
        this.pending.delete(r.token);
        if (r.command === 'error') {
          waiter.reject(new Error(this.asString(r.results.msg) || 'GDB error'));
        } else {
          waiter.resolve(r);
        }
      } else if (r.kind === 'exec') {
        if (r.command === 'stopped') {
          this.status = 'Stopped';
          const waiters = this.stopWaiters.splice(0);
          for (const w of waiters) w();
          if (!this.suppressStopped) {
            this.stop(this.mapStopReason(r.results));
          }
        } else if (r.command === 'running') {
          this.status = 'Running';
        }
      } else if (r.kind === 'stream' && r.text) {
        if (r.command === '&') {
          this.logOutput(r.text, 'stderr');
        } else if (r.command === '~' || r.command === '@') {
          this.logOutput(r.text, 'console');
        }
      }
    }
  }

  private mapStopReason(results: MIObject): string {
    const reason = this.asString(results.reason);
    switch (reason) {
      case 'breakpoint-hit': return 'breakpoint';
      case 'end-stepping-range':
      case 'function-finished': return 'step';
      case 'signal-received':
        return this.asString(results['signal-name']) === 'SIGINT' ? 'pause' : 'exception';
      default:
        return 'pause';
    }
  }

  private mi(command: string): Promise<MIRecord> {
    if (!this.gdb || this.gdb.killed || this.gdb.exitCode !== null) {
      return Promise.reject(new Error(`GDB is not running (command: ${command})`));
    }
    return new Promise((resolve, reject) => {
      const t = this.token++;
      this.pending.set(t, { resolve, reject });
      this.gdb!.stdin.write(`${t}-${command}\n`);
      setTimeout(() => {
        if (this.pending.delete(t)) {
          reject(new Error(`GDB timeout: ${command}`));
        }
      }, 10000);
    });
  }

  private interruptTarget() {
    if (this.gdb?.pid) {
      try {
        process.kill(this.gdb.pid, 'SIGINT');
      } catch {
        // Ignore if process already exited
      }
    }
  }

  private waitForStop(timeoutMs = 2000): Promise<void> {
    if (this.status === 'Stopped') return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.stopWaiters.indexOf(onStop);
        if (idx >= 0) this.stopWaiters.splice(idx, 1);
        reject(new Error('Timed out waiting for target to halt.'));
      }, timeoutMs);
      const onStop = () => {
        clearTimeout(timer);
        resolve();
      };
      this.stopWaiters.push(onStop);
    });
  }

  private async withTargetHalted<T>(fn: () => Promise<T>): Promise<T> {
    const wasRunning = this.status === 'Running';
    if (wasRunning) {
      this.suppressStopped = true;
      try {
        this.interruptTarget();
        await this.waitForStop();
      } finally {
        this.suppressStopped = false;
      }
    }
    try {
      return await fn();
    } finally {
      if (wasRunning && this.status === 'Stopped') {
        await this.mi('exec-continue');
        this.status = 'Running';
      }
    }
  }

  private async handleSetBreakpoints(m: DAPRequest) {
    const sourcePath: string | undefined = m.arguments?.source?.path;
    const requested: Array<{ line: number; condition?: string }> = m.arguments?.breakpoints || [];
    if (!sourcePath) {
      this.reply(m, { breakpoints: requested.map((b) => ({ line: b.line, verified: false })) });
      return;
    }

    const resultBreakpoints = await this.withTargetHalted(async () => {
      const prevIds = this.breakpointsByFile.get(sourcePath) || [];
      if (prevIds.length > 0) {
        try {
          await this.mi(`break-delete ${prevIds.join(' ')}`);
        } catch {
          // Ignore already-deleted breakpoints
        }
      }

      const newIds: number[] = [];
      const out: Array<{ id?: number; line: number; verified: boolean; message?: string }> = [];
      for (const b of requested) {
        try {
          const condFlag = b.condition ? `-c "${this.escapeMI(b.condition)}" ` : '';
          const rec = await this.mi(`break-insert ${condFlag}"${this.escapeMI(sourcePath)}:${b.line}"`);
          const bkpt = this.asObject(rec.results.bkpt);
          const id = bkpt?.number ? Number(this.asString(bkpt.number)) : undefined;
          const line = bkpt?.line ? Number(this.asString(bkpt.line)) : b.line;
          if (id !== undefined && !Number.isNaN(id)) newIds.push(id);
          out.push({ id, line, verified: true });
        } catch (err) {
          out.push({
            line: b.line,
            verified: false,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
      this.breakpointsByFile.set(sourcePath, newIds);
      return out;
    });

    this.reply(m, { breakpoints: resultBreakpoints });
  }

  private async handleStackTrace(m: DAPRequest) {
    const rec = await this.mi('stack-list-frames');
    const stackList = this.asArray(rec.results.stack);
    const stackFrames = stackList.map((entry, idx) => {
      const raw = this.asObject(entry);
      const frame = raw?.frame ? this.asObject(raw.frame) : raw;
      const fullname = this.asString(frame?.fullname) || this.asString(frame?.file);
      const lineStr = this.asString(frame?.line);
      const addr = this.asString(frame?.addr);
      return {
        id: frame?.level ? Number(this.asString(frame.level)) : idx,
        name: this.asString(frame?.func) || addr || `frame #${idx}`,
        source: fullname ? { name: path.basename(fullname), path: fullname } : undefined,
        line: lineStr ? Number(lineStr) : 0,
        column: 0,
        instructionPointerReference: addr || undefined,
      };
    });
    this.reply(m, { stackFrames, totalFrames: stackFrames.length });
  }

  private async handleVariables(m: DAPRequest) {
    if (m.arguments?.variablesReference !== LOCALS_SCOPE_REF) {
      this.reply(m, { variables: [] });
      return;
    }

    const varsRec = await this.mi(`stack-list-variables --thread 1 --frame ${this.activeFrameId} --simple-values`);
    const vars = this.asArray(varsRec.results.variables).map((item) => {
      const obj = this.asObject(item);
      return {
        name: this.asString(obj?.name),
        value: this.asString(obj?.value) || '{...}',
        type: this.asString(obj?.type) || undefined,
        variablesReference: 0,
      };
    });
    this.reply(m, { variables: vars });
  }

  /**
   * Refreshes the dedicated Target, Registers, LEDs, and Memory sidebar views when stopped.
   */
  async refreshPeripheralViews(): Promise<void> {
    if (!this.views || this.status !== 'Stopped' || this.terminated) return;

    try {
      const regs = await this.readRegisters();
      if (this.status === 'Stopped') this.views.setRegisters(regs);
    } catch {
      // Ignore transient read errors while stepping/resuming
    }

    try {
      const addr = this.cfg.ledRegister || '0x40028000';
      const hex = await this.readMemoryHex(addr, 4);
      if (this.status === 'Stopped' && hex.length >= 8) {
        const val = this.parseLittleEndianWord(hex);
        this.lastLedValue = val;
        this.views.setLeds({ address: addr, rawValue: val });
      }
    } catch {
      // Ignore if target cannot read LED register
    }

    await this.refreshMemoryView();
  }

  async refreshMemoryView(): Promise<void> {
    if (!this.views || this.status !== 'Stopped' || this.terminated) return;
    const req = this.views.getMemoryRequest();
    try {
      const hex = await this.readMemoryHex(req.address, req.byteCount);
      if (this.status === 'Stopped') {
        this.views.setMemoryHex(req.address, hex);
      }
    } catch (err) {
      if (this.status === 'Stopped') {
        this.views.setMemoryError(req.address, err instanceof Error ? err.message : String(err));
      }
    }
  }

  async readMemoryToView(address: string): Promise<void> {
    if (this.status !== 'Stopped') {
      throw new Error('Target must be stopped before reading memory.');
    }
    const req = this.views?.getMemoryRequest();
    const hex = await this.readMemoryHex(address, req?.byteCount ?? 80);
    this.views?.setMemoryHex(address, hex);
  }

  async writeRegister(name: string, rawValue: string): Promise<void> {
    if (this.status !== 'Stopped') {
      throw new Error('Target must be stopped before editing registers.');
    }
    const aliases: Record<string, string> = {
      ctrl: 'control',
      pmask: 'primask',
      fmask: 'faultmask',
      bpri: 'basepri',
    };
    const trimmed = name.trim();
    const cleanName = aliases[trimmed] || trimmed;
    if (!/^[a-zA-Z0-9_]+$/.test(cleanName)) {
      throw new Error(`Invalid register name: ${name}`);
    }
    const num = Number(rawValue.trim());
    if (!Number.isFinite(num)) {
      throw new Error(`Invalid value: ${rawValue}`);
    }
    const valHex = `0x${(num >>> 0).toString(16)}`;
    await this.mi(`interpreter-exec console "set $${cleanName} = ${valHex}"`);
    await this.refreshPeripheralViews();
  }

  async writeMemoryWord(address: string, value: number): Promise<void> {
    if (this.status !== 'Stopped') {
      throw new Error('Target must be stopped before writing memory.');
    }
    const addrNum = Number(address);
    if (!Number.isFinite(addrNum)) {
      throw new Error(`Invalid address: ${address}`);
    }
    const addrHex = `0x${(addrNum >>> 0).toString(16)}`;
    const valHex = `0x${(value >>> 0).toString(16)}`;
    await this.mi(`interpreter-exec console "set {unsigned int}${addrHex} = ${valHex}"`);
    await this.refreshPeripheralViews();
  }

  private async readRegisters(): Promise<RegisterEntry[]> {
    if (this.registerNames.length === 0) {
      const namesRec = await this.mi('data-list-register-names');
      this.registerNames = this.asArray(namesRec.results['register-names']).map((v) => this.asString(v));
    }
    const valsRec = await this.mi('data-list-register-values x');
    return this.asArray(valsRec.results['register-values'])
      .map((item) => {
        const obj = this.asObject(item);
        const num = Number(this.asString(obj?.number));
        const name = this.registerNames[num] || '';
        const value = this.asString(obj?.value);
        return { name, value };
      })
      .filter((r) => r.name.length > 0);
  }

  private async readMemoryHex(addr: string, byteCount: number): Promise<string> {
    const rec = await this.mi(`data-read-memory-bytes ${addr} ${byteCount}`);
    const mem = this.asObject(this.asArray(rec.results.memory)[0]);
    return this.asString(mem?.contents);
  }

  private parseLittleEndianWord(hex: string): number {
    const bytes = hex.slice(0, 8).match(/.{2}/g)!.map((b) => parseInt(b, 16));
    return ((bytes[3] << 24) | (bytes[2] << 16) | (bytes[1] << 8) | bytes[0]) >>> 0;
  }

  private async handleEvaluate(m: DAPRequest) {
    const expr = String(m.arguments?.expression ?? '').trim();
    const frameId = m.arguments?.frameId ?? this.activeFrameId;
    const context = m.arguments?.context;

    if (context === 'repl' && expr.startsWith('>')) {
      const cmd = expr.slice(1).trim();
      await this.mi(`interpreter-exec console "${this.escapeMI(cmd)}"`);
      this.reply(m, { result: '', variablesReference: 0 });
      return;
    }

    try {
      const rec = await this.mi(`data-evaluate-expression --thread 1 --frame ${frameId} "${this.escapeMI(expr)}"`);
      this.reply(m, { result: this.asString(rec.results.value), variablesReference: 0 });
    } catch (err) {
      if (context === 'repl') {
        await this.mi(`interpreter-exec console "${this.escapeMI(expr)}"`);
        this.reply(m, { result: '', variablesReference: 0 });
      } else {
        throw err;
      }
    }
  }

  private async handleDisassemble(m: DAPRequest) {
    const baseRef = String(m.arguments?.memoryReference || '$pc');
    const offset = Number(m.arguments?.offset || 0);
    const count = Math.max(1, Number(m.arguments?.instructionCount || 32));
    const startExpr = baseRef.startsWith('0x')
      ? `0x${Math.max(0, parseInt(baseRef, 16) + offset).toString(16)}`
      : baseRef;
    const endExpr = startExpr.startsWith('0x')
      ? `0x${(parseInt(startExpr, 16) + count * 4).toString(16)}`
      : `${startExpr}+${count * 4}`;

    const rec = await this.mi(`data-disassemble -s "${this.escapeMI(startExpr)}" -e "${this.escapeMI(endExpr)}" -- 0`);
    const insns = this.asArray(rec.results.asm_insns).slice(0, count).map((item) => {
      const obj = this.asObject(item);
      return {
        address: this.asString(obj?.address),
        instruction: this.asString(obj?.inst).replace(/\t+/g, ' '),
        symbol: this.asString(obj?.['func-name']) || undefined,
      };
    });
    this.reply(m, { instructions: insns });
  }

  async getMixedSourceAssembly(): Promise<SourceAssemblyLine[]> {
    if (this.status !== 'Stopped' || this.terminated) return [];
    const pcRec = await this.mi('data-evaluate-expression "(unsigned int)$pc"');
    const pcNumber = Number(this.asString(pcRec.results.value));
    if (!Number.isFinite(pcNumber)) return [];
    const pc = `0x${(pcNumber >>> 0).toString(16).padStart(8, '0')}`;

    let rec: MIRecord;
    try {
      const frameRec = await this.mi('stack-list-frames 0 0');
      const rawFrame = this.asObject(this.asArray(frameRec.results.stack)[0]);
      const frame = rawFrame?.frame ? this.asObject(rawFrame.frame) : rawFrame;
      const fullname = this.asString(frame?.fullname);
      if (fullname) {
        rec = await this.mi(`data-disassemble -f "${this.escapeMI(fullname)}" -l 1 -- 1`);
      } else {
        const end = `0x${((pcNumber >>> 0) + 160).toString(16)}`;
        rec = await this.mi(`data-disassemble -s "${pc}" -e "${end}" -- 1`);
      }
    } catch {
      const end = `0x${((pcNumber >>> 0) + 160).toString(16)}`;
      rec = await this.mi(`data-disassemble -s "${pc}" -e "${end}" -- 1`);
    }

    const lines: SourceAssemblyLine[] = [];
    for (const entry of this.asArray(rec.results.asm_insns)) {
      const group = this.asObject(entry);
      const source = this.asObject(group?.src_and_asm_line);
      const rawFile = this.asString(source?.fullname) || this.asString(source?.file);
      const line = Number(this.asString(source?.line));
      if (!rawFile || !Number.isFinite(line) || line < 1) continue;
      const file = path.resolve(this.root, rawFile);
      const instructions = this.asArray(source?.line_asm_insn).map((item) => {
        const asm = this.asObject(item);
        return { address: this.asString(asm?.address), instruction: this.asString(asm?.inst).replace(/\t+/g, ' ') };
      }).filter((instruction) => instruction.instruction.length > 0);
      if (instructions.length) lines.push({ file, line, instructions, pc });
    }
    return lines;
  }

  private stop(reason: string) {
    this.status = 'Stopped';
    void this.refreshPeripheralViews();
    this.onStopped?.();
    this.sendEvent('stopped', { reason, threadId: 1, allThreadsStopped: true });
  }

  private end() {
    if (this.terminated) return;
    this.terminated = true;
    this.stopQmpLedMonitor();
    this.rejectAllPending(new Error('Debug session terminated'));
    if (this.gdb?.pid) treeKill(this.gdb.pid, 'SIGTERM', () => undefined);
    if (this.qemu?.pid) treeKill(this.qemu.pid, 'SIGTERM', () => undefined);
    this.gdb = undefined;
    this.qemu = undefined;
    this.status = 'Disconnected';
    this.views?.clearSession();
    this.onResumed?.();
    this.sendEvent('terminated');
  }

  private findFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.unref();
      srv.on('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address();
        const port = addr && typeof addr === 'object' ? addr.port : 0;
        srv.close(() => (port ? resolve(port) : reject(new Error('No free port'))));
      });
    });
  }

  private startQmpLedMonitor(port: number) {
    if (!this.views || this.terminated) return;
    const rawAddr = this.cfg.ledRegister || '0x40028000';
    const addrNum = Number(rawAddr);
    if (!Number.isFinite(addrNum)) return;
    const addrHex = `0x${(addrNum >>> 0).toString(16)}`;

    const sock = net.createConnection({ host: '127.0.0.1', port });
    this.qmpSocket = sock;
    let buf = '';
    let capSent = false;
    let ready = false;
    let inFlight = false;
    let qmpId = 2;

    sock.on('data', (chunk) => {
      buf += chunk.toString();
      for (;;) {
        const nl = buf.indexOf('\n');
        if (nl < 0) break;
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.QMP && !capSent) {
          capSent = true;
          sock.write(JSON.stringify({ execute: 'qmp_capabilities', id: 1 }) + '\n');
        } else if (msg.id === 1 && !ready) {
          ready = true;
          this.qmpTimer = setInterval(() => {
            if (this.terminated || sock.destroyed || inFlight) return;
            inFlight = true;
            sock.write(
              JSON.stringify({
                execute: 'human-monitor-command',
                arguments: { 'command-line': `xp /1wx ${addrHex}` },
                id: qmpId++,
              }) + '\n'
            );
          }, 60);
        } else if (typeof msg.id === 'number' && msg.id >= 2) {
          inFlight = false;
          if (typeof msg.return === 'string') {
            const match = msg.return.match(/:\s*0x([0-9a-fA-F]+)/);
            if (match) {
              const val = parseInt(match[1], 16) >>> 0;
              if (val !== this.lastLedValue) {
                this.lastLedValue = val;
                this.views?.setLeds({ address: rawAddr, rawValue: val });
              }
            }
          }
        }
      }
    });

    sock.on('error', () => this.stopQmpLedMonitor());
    sock.on('close', () => this.stopQmpLedMonitor());
  }

  private stopQmpLedMonitor() {
    if (this.qmpTimer) {
      clearInterval(this.qmpTimer);
      this.qmpTimer = undefined;
    }
    if (this.qmpSocket) {
      this.qmpSocket.destroy();
      this.qmpSocket = undefined;
    }
    this.lastLedValue = undefined;
  }

  private escapeMI(s: string): string {
    return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  private asString(v: MIValue | undefined): string {
    return typeof v === 'string' ? v : '';
  }

  private asObject(v: MIValue | undefined): MIObject | undefined {
    return v && typeof v === 'object' && !Array.isArray(v) ? v : undefined;
  }

  private asArray(v: MIValue | undefined): MIValue[] {
    return Array.isArray(v) ? v : [];
  }
}
