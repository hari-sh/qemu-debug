# qemu-debug

VSCode debugging extension for QEMU Cortex-M3 firmware on `mps2-an385`.

Run `npm install` and `npm run compile` to build the extension. Add a `qemu-m3` configuration to the workspace `.vscode/launch.json`; a complete example is in [`sample/.vscode/launch.json`](sample/.vscode/launch.json). Values can use `${make:VAR}` placeholders resolved from the workspace `Makefile` (`TARGET`, `QEMU`, `GDB`, `QEMU_MACH`, `LED_ADDR`).
