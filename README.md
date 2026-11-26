# qemu-debug

VS Code debugging extension for ARM Cortex-M3 firmware running on QEMU (`mps2-an385`), built on GDB/MI2 and QEMU Monitor Protocol (QMP).

## Features

- **Launch & Attach Debugging**
  - Spawns `qemu-system-arm` (`-S -gdb`, `-kernel`) and `arm-none-eabi-gdb` (`--interpreter=mi2`), or attaches to an already-running QEMU GDB server.
  - Breakpoints (including conditional breakpoints and live breakpoint updates while running), step over/in/out, instruction-level stepping, pause (`SIGINT`), call stack, locals, watch/hover evaluation, and Debug Console (prefix commands with `>` to run raw GDB console commands).
- **Registers View + Live LED Strip**
  - **Live 8-LED Strip**: Pinned at the top of the **Registers** tab and active only while debugging. Polls `ledRegister` over QEMU QMP every `60ms` so LEDs update in real time **whether the target is running or paused** without halting the CPU (falls back to GDB reads on stop in `attach` mode).
  - **Two-Column CPU Registers**: Displays Cortex-M3 registers (`r0`–`r12`, `sp`, `lr`, `pc`, `xpsr`, `msp`, `psp`, `ctrl`, `pmask`, `fmask`, `bpri`) in a compact two-column layout with inline click-to-edit (`Enter` or click outside to commit, `Escape` to cancel).
- **Memory View**
  - Defaults to `0x00000000` and shows **10 rows** (`80` bytes total), incrementing by `+8` bytes per row with two 4-byte words (`addr: word0  word1`).
  - Includes an inline start-address bar (`Enter` or **Read**) and inline click-to-edit on any 4-byte word (`Enter` or click outside to commit, `Escape` to cancel).
- **Mixed C + Tabbed Disassembly**
  - Displays a compact `▸` / `▾` arrow above every compiled line across all functions in the file.
  - Clicking `▸` opens a read-only mixed source + tabbed disassembly view (`qemu-asm`) beside the editor with `▶` marking the current `$pc` instruction and live updates while stepping.
- **`Makefile` Variable Resolution (`${make:VAR}`)**
  - Runs `buildCommand` before launch and resolves `${make:VAR}` placeholders directly from the workspace `Makefile` (including nested variables such as `TARGET = $(BUILD_DIR)/rtos.elf`).

---

## Prerequisites

- **VS Code** `>= 1.85.0`
- **QEMU**: `qemu-system-arm`
- **ARM GNU Toolchain**: `arm-none-eabi-gdb` (and `arm-none-eabi-gcc` + `make` to build firmware)

On macOS (Homebrew):

```sh
brew install qemu arm-none-eabi-gcc arm-none-eabi-gdb
```

---

## Quick Start

### 1. Firmware `Makefile`

Compile with `-O0 -g` for full source-level debugging and disassembly, and define the variables referenced by `launch.json`:

```makefile
CC           = arm-none-eabi-gcc
GDB          = arm-none-eabi-gdb
QEMU         = qemu-system-arm
QEMU_MACH    = mps2-an385
LED_ADDR     = 0x40028000

PLATFORM_DIR = ../platform
BUILD_DIR    = build
TARGET       = $(BUILD_DIR)/rtos.elf

CFLAGS       = -mcpu=cortex-m3 -mthumb -ffreestanding -O0 -g -Wall -I. -Ibsp -I$(PLATFORM_DIR)
LDFLAGS      = -T $(PLATFORM_DIR)/linker.ld -nostartfiles -nostdlib
SRCS         = $(PLATFORM_DIR)/startup.c main.c

all: $(TARGET)

$(TARGET): $(SRCS) $(PLATFORM_DIR)/linker.ld $(PLATFORM_DIR)/mps2_an385.h
	mkdir -p $(BUILD_DIR)
	$(CC) $(CFLAGS) $(LDFLAGS) $(SRCS) -o $(TARGET)

clean:
	rm -rf $(BUILD_DIR)

.PHONY: all clean
```

### 2. `.vscode/launch.json`

Add a `qemu-m3` configuration to your firmware workspace `.vscode/launch.json` (see [`sample/.vscode/launch.json`](sample/.vscode/launch.json)):

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
      "ledRegister": "${make:LED_ADDR}"
    }
  ]
}
```

> **Note:** `${make:VAR}` reads variables from the `Makefile` in `${workspaceFolder}` (or the `-C <dir>` directory in `buildCommand`). If a referenced variable is missing from the `Makefile`, launch fails with a clear error naming the missing variable.

### 3. Debug

1. Open your firmware workspace and press **F5** (**Run and Debug → Debug Firmware**).
2. In the **Run and Debug** sidebar:
   - **Registers**: View the live 8-LED strip at the top and edit registers inline by clicking any hex value (`Enter` or click outside to apply, `Escape` to cancel).
   - **Memory**: Enter any hex/decimal address and press `Enter` or **Read** to inspect 10 eight-byte rows; click either 4-byte word on a row to edit memory inline.
3. Click **`▸`** above any compiled C line to open/collapse tabbed multi-line assembly beside the source editor.
4. In the **Debug Console**, evaluate C expressions directly or prefix raw GDB commands with `>` (for example, `>info breakpoints`).

---

## Configuration Reference

### `launch`

| Property | Required | Default | Description |
| --- | --- | --- | --- |
| `type` | Yes | — | Must be `"qemu-m3"` |
| `request` | Yes | — | `"launch"` |
| `name` | Yes | — | Configuration name shown in VS Code |
| `elfFile` | Yes | — | Path to compiled `.elf` firmware (supports `${workspaceFolder}` and `${make:VAR}`) |
| `qemuPath` | No | `qemu-system-arm` | Path or binary name for QEMU |
| `gdbPath` | No | `arm-none-eabi-gdb` | Path or binary name for ARM GDB |
| `gdbPort` | No | `3333` | TCP port for QEMU GDB server |
| `machine` | No | `mps2-an385` | QEMU `-M` machine name |
| `buildCommand` | No | — | Shell command run before starting QEMU (e.g. `"make -C ${workspaceFolder}"`) |
| `ledRegister` | No | `0x40028000` | 32-bit MMIO address monitored for the 8-LED strip |
| `stopOnEntry` | No | `true` | Halt at `Reset_Handler` on start (`false` continues immediately) |

### `attach`

| Property | Required | Default | Description |
| --- | --- | --- | --- |
| `type` | Yes | — | Must be `"qemu-m3"` |
| `request` | Yes | — | `"attach"` |
| `name` | Yes | — | Configuration name |
| `elfFile` | No | — | Path to `.elf` symbols file |
| `gdbPath` | No | `arm-none-eabi-gdb` | Path or binary name for ARM GDB |
| `gdbPort` | No | `3333` | TCP port of the running QEMU GDB server |

---

## Development & Packaging

```sh
npm install
npm test        # Type-check (tsc --noEmit) and bundle (esbuild)
npm run watch   # Rebuild on changes
npm run package # Build qemu-debug-<version>.vsix via vsce
```

To run locally in VS Code, press **F5** (**Run qemu-debug Extension**), or install the packaged `.vsix` via **Extensions → `...` → Install from VSIX...** (or `code --install-extension qemu-debug-0.1.1.vsix`).
