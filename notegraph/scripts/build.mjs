// esbuild pipeline: bundles the Electron main process + preload (CJS), the
// renderer app (browser IIFE), the demo-data generator tool, and copies
// static renderer assets into dist/.
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  sourcemap: true,
  logLevel: 'info',
  absWorkingDir: root,
};

const targets = [
  {
    ...common,
    entryPoints: [join(root, 'src/main/main.ts')],
    outfile: join(root, 'dist/main/main.cjs'),
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
  },
  {
    ...common,
    entryPoints: [join(root, 'src/main/preload.ts')],
    outfile: join(root, 'dist/main/preload.cjs'),
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
  },
  {
    ...common,
    entryPoints: [join(root, 'src/renderer/app.ts')],
    outfile: join(root, 'dist/renderer/app.js'),
    platform: 'browser',
    format: 'iife',
  },
  {
    ...common,
    entryPoints: [join(root, 'src/tools/gen_demo_data.ts')],
    outfile: join(root, 'dist/tools/gen_demo_data.cjs'),
    platform: 'node',
    format: 'cjs',
  },
];

function copyStatic() {
  mkdirSync(join(root, 'dist/renderer'), { recursive: true });
  for (const file of ['index.html', 'styles.css']) {
    cpSync(join(root, 'src/renderer', file), join(root, 'dist/renderer', file));
  }
}

if (watch) {
  const contexts = await Promise.all(targets.map((t) => esbuild.context(t)));
  copyStatic();
  await Promise.all(contexts.map((c) => c.watch()));
  console.log('watching for changes...');
} else {
  await Promise.all(targets.map((t) => esbuild.build(t)));
  copyStatic();
}
