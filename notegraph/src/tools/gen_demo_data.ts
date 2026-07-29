import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { MetadataCache, makeFileMetadata } from '../core/metadata_cache';
import { buildGraph, computeStats } from '../core/graph_builder';
import { ATTACHMENT_EXTENSIONS } from '../shared/types';

function extensionOf(fileName: string): string {
  const dotIndex = fileName.lastIndexOf('.');
  if (dotIndex <= 0) {
    return '';
  }
  return fileName.slice(dotIndex + 1).toLowerCase();
}

async function collectVaultFiles(vaultRoot: string): Promise<string[]> {
  const relativePaths: string[] = [];

  async function walk(absoluteDirectory: string, relativeDirectory: string): Promise<void> {
    const entries = await fs.readdir(absoluteDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) {
        continue;
      }
      const absoluteEntry = path.join(absoluteDirectory, entry.name);
      const relativeEntry =
        relativeDirectory === '' ? entry.name : relativeDirectory + '/' + entry.name;
      if (entry.isDirectory()) {
        await walk(absoluteEntry, relativeEntry);
      } else if (entry.isFile()) {
        const extension = extensionOf(entry.name);
        if (extension === 'md' || ATTACHMENT_EXTENSIONS.has(extension)) {
          relativePaths.push(relativeEntry);
        }
      }
    }
  }

  await walk(vaultRoot, '');
  return relativePaths.sort();
}

async function main(): Promise<void> {
  const vaultPath = path.resolve(process.cwd(), process.argv[2] ?? 'demo-vault');
  const outPath = path.resolve(process.cwd(), process.argv[3] ?? 'demo/graph-data.json');

  const cache = new MetadataCache();
  for (const relativePath of await collectVaultFiles(vaultPath)) {
    const absolutePath = path.join(vaultPath, ...relativePath.split('/'));
    const fileStats = await fs.stat(absolutePath);
    const isMarkdown = extensionOf(relativePath) === 'md';
    const source = isMarkdown ? await fs.readFile(absolutePath, 'utf8') : null;
    cache.setFile(
      makeFileMetadata(relativePath, source, {
        mtimeMs: fileStats.mtimeMs,
        size: fileStats.size,
      }),
    );
  }

  const graph = buildGraph(cache);
  const stats = computeStats(cache, vaultPath);

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify({ graph, stats }, null, 2) + '\n', 'utf8');

  console.log(
    `notegraph demo data: ${stats.fileCount} files ` +
      `(${stats.noteCount} notes, ${stats.attachmentCount} attachments), ` +
      `${graph.nodes.length} nodes, ${graph.edges.length} edges -> ${outPath}`,
  );
}

// Bundled to CJS, so no top-level await; failures surface via the exit code.
main().catch((error: unknown) => {
  console.error('gen_demo_data failed:', error);
  process.exitCode = 1;
});
