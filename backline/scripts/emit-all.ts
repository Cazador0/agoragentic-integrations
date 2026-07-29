/**
 * Emit every partner-runtime descriptor from the operation registry.
 *
 * The gap-11 closure in practice: one command produces the Agentforce External
 * Service, the Breeze action manifest, the monday app manifest, OpenAI and
 * LangChain tool definitions, AG-UI render hints, and Zapier actions.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { emitAll } from "../packages/emitters/dist/index.js";

const baseUrl = process.env.BACKLINE_BASE_URL ?? "https://api.backline.example";
const outDir = join(process.cwd(), "dist-emitters");

for (const output of emitAll(baseUrl)) {
  const target = join(outDir, output.filename);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(output.body, null, 2)}\n`, "utf8");
  console.log(`${output.surface.padEnd(11)} ${output.filename}`);
}
console.log(`\nEmitted to ${outDir}`);
