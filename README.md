# qemu-debug

VS Code debugging extension for ARM Cortex-M3 firmware running on QEMU (`mps2-an385`), built on GDB/MI2 and QMP.

## Features

- **Launch & Attach Debugging**: Spawns `qemu-system-arm` (`-S -gdb`, `-kernel`) and `arm-none-eabi-gdb` (`--interpreter=mi2`), or attaches to a running QEMU GDB server. Supports breakpoints (conditional and while running), stepping, pause, call stack, locals, hover/watch evaluation, and Debug Console (prefix raw GDB commands with `>`).
- **Registers & Live 8-LED Strip**: Compact two-column Cortex-M3 register view with inline click-to-edit (`Enter` or blur to apply, `Escape` to cancel), plus a pinned 8-LED strip polled via QMP every `60ms` while running (or GDB fallback on stop in `attach` mode).
- **Memory View**: Shows 10 eight-byte rows (`0x00000000` default) with start-address navigation and inline click-to-edit on any 4-byte word.
- **Side-by-Side Disassembly View**: Controlled by `"disassembly": true` in `launch.json` (enabled by default; set `"disassembly": false` to turn off). Keeps the active source file on top in the first pane and VS Code's built-in Disassembly View (address + mnemonics with C source overlay, assembly breakpoints, and instruction stepping) on top in the second pane, closing Disassembly when the session ends.
- **`Makefile` Interpolation (`${make:VAR}`)**: Runs `buildCommand` before launch and resolves `${make:VAR}` placeholders from the workspace `Makefile`.

## Prerequisites

- **VS Code** `>= 1.85.0`
- **QEMU**: `qemu-system-arm`
- **ARM GNU Toolchain**: `arm-none-eabi-gdb`

## `.vscode/launch.json`

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "qemu-m3",
      "request": "launch",
      "name": "Debug Firmware",
      "elfFile": "${workspaceFolder}/${make:TARGET}",
      "qemuPath": "${make:QEMU}",
      "gdbPath": "${make:GDB}",
      "gdbPort": 3333,
      "machine": "${make:QEMU_MACH}",
      "buildCommand": "make -C ${workspaceFolder}",
      "ledRegister": "${make:LED_ADDR}",
      "disassembly": true
    }
  ]
}
```

`${make:VAR}` reads variables from the `Makefile` in `${workspaceFolder}` (or the `-C <dir>` directory in `buildCommand`).

## Configuration Reference

### `launch`

| Property | Required | Default | Description |
| --- | --- | --- | --- |
| `type` | Yes | — | Must be `"qemu-m3"` |
| `request` | Yes | — | `"launch"` |
| `name` | Yes | — | Configuration name |
| `elfFile` | Yes | — | Path to compiled `.elf` firmware (supports `${workspaceFolder}` and `${make:VAR}`) |
| `qemuPath` | No | `qemu-system-arm` | Path or binary name for QEMU |
| `gdbPath` | No | `arm-none-eabi-gdb` | Path or binary name for ARM GDB |
| `gdbPort` | No | `3333` | TCP port for QEMU GDB server |
| `machine` | No | `mps2-an385` | QEMU `-M` machine name |
| `buildCommand` | No | — | Shell command run before starting QEMU |
| `ledRegister` | No | `0x40028000` | 32-bit MMIO address monitored for the 8-LED strip |
| `stopOnEntry` | No | `true` | Halt at `Reset_Handler` on start (`false` continues immediately) |
| `disassembly` | No | `true` | Keep source and Disassembly View open side-by-side while debugging |

### `attach`

| Property | Required | Default | Description |
| --- | --- | --- | --- |
| `type` | Yes | — | Must be `"qemu-m3"` |
| `request` | Yes | — | `"attach"` |
| `name` | Yes | — | Configuration name |
| `elfFile` | No | — | Path to `.elf` symbols file |
| `gdbPath` | No | `arm-none-eabi-gdb` | Path or binary name for ARM GDB |
| `gdbPort` | No | `3333` | TCP port of the running QEMU GDB server |
| `disassembly` | No | `true` | Keep source and Disassembly View open side-by-side while debugging |

## Development

```sh
npm install
npm test        # Type-check (tsc --noEmit) and bundle (esbuild)
npm run watch   # Rebuild on changes
npm run package # Build .vsix via vsce
```
