export type MIValue = string | MIObject | MIValue[];
export interface MIObject {
  [key: string]: MIValue;
}

export interface MIRecord {
  kind: 'result' | 'exec' | 'notify' | 'status' | 'stream';
  token?: number;
  command: string;
  results: MIObject;
  text?: string;
}

/**
 * Incremental parser for GDB/MI2 output lines.
 */
export class MIParser {
  private buffer = '';

  feed(chunk: string): MIRecord[] {
    this.buffer += chunk;
    const out: MIRecord[] = [];
    for (;;) {
      const idx = this.buffer.indexOf('\n');
      if (idx < 0) break;
      const line = this.buffer.slice(0, idx).replace(/\r$/, '');
      this.buffer = this.buffer.slice(idx + 1);
      const record = this.parseLine(line);
      if (record) out.push(record);
    }
    return out;
  }

  private parseLine(line: string): MIRecord | undefined {
    if (!line || line === '(gdb)' || line === '(gdb) ') return undefined;

    const streamMatch = line.match(/^([~@&])(".*")$/);
    if (streamMatch) {
      const text = new LineReader(streamMatch[2]).readString();
      return { kind: 'stream', command: streamMatch[1], results: {}, text };
    }

    const recMatch = line.match(/^(\d+)?([\^*+=])([a-zA-Z_-]+)(?:,(.*))?$/);
    if (!recMatch) return undefined;

    const [, tokenStr, prefix, command, rest] = recMatch;
    const kindMap: Record<string, MIRecord['kind']> = {
      '^': 'result',
      '*': 'exec',
      '=': 'notify',
      '+': 'status',
    };
    const results = rest ? new LineReader(rest).readObjectBody() : {};
    return {
      kind: kindMap[prefix],
      token: tokenStr ? Number(tokenStr) : undefined,
      command,
      results,
    };
  }
}

class LineReader {
  private pos = 0;

  constructor(private readonly src: string) {}

  readObjectBody(stopChar?: string): MIObject {
    const obj: MIObject = {};
    while (this.pos < this.src.length) {
      if (stopChar && this.src[this.pos] === stopChar) break;
      if (this.src[this.pos] === ',') {
        this.pos++;
        continue;
      }
      const eqIdx = this.src.indexOf('=', this.pos);
      if (eqIdx < 0) break;
      const key = this.src.slice(this.pos, eqIdx).trim();
      this.pos = eqIdx + 1;
      obj[key] = this.readValue();
    }
    return obj;
  }

  readValue(): MIValue {
    const ch = this.src[this.pos];
    if (ch === '"') return this.readString();
    if (ch === '{') return this.readTuple();
    if (ch === '[') return this.readList();
    // Fallback for unexpected bare token
    const start = this.pos;
    while (this.pos < this.src.length && !',}]'.includes(this.src[this.pos])) {
      this.pos++;
    }
    return this.src.slice(start, this.pos);
  }

  readString(): string {
    if (this.src[this.pos] !== '"') return '';
    this.pos++;
    let out = '';
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos++];
      if (ch === '"') return out;
      if (ch === '\\' && this.pos < this.src.length) {
        const esc = this.src[this.pos++];
        switch (esc) {
          case 'n': out += '\n'; break;
          case 'r': out += '\r'; break;
          case 't': out += '\t'; break;
          case '\\': out += '\\'; break;
          case '"': out += '"'; break;
          default: out += esc; break;
        }
      } else {
        out += ch;
      }
    }
    return out;
  }

  private readTuple(): MIObject {
    this.pos++; // '{'
    const obj = this.readObjectBody('}');
    if (this.src[this.pos] === '}') this.pos++;
    return obj;
  }

  private readList(): MIValue[] {
    this.pos++; // '['
    const items: MIValue[] = [];
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos];
      if (ch === ']') {
        this.pos++;
        return items;
      }
      if (ch === ',') {
        this.pos++;
        continue;
      }
      // Lists in GDB/MI can contain bare values ("a", {...}) or key=value pairs (frame={...})
      if (ch === '"' || ch === '{' || ch === '[') {
        items.push(this.readValue());
      } else {
        const eqIdx = this.src.indexOf('=', this.pos);
        if (eqIdx < 0) break;
        const key = this.src.slice(this.pos, eqIdx).trim();
        this.pos = eqIdx + 1;
        items.push({ [key]: this.readValue() });
      }
    }
    return items;
  }
}
