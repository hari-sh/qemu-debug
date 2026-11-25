const esbuild = require('esbuild');
const options = { entryPoints: ['src/extension.ts'], bundle: true, outfile: 'dist/extension.js', external: ['vscode'], platform: 'node', format: 'cjs', sourcemap: true };
(process.argv.includes('--watch') ? esbuild.context(options).then(c => c.watch()) : esbuild.build(options)).catch(() => process.exit(1));
