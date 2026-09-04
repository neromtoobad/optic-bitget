// Full pipeline CLI: npx tsx scripts/read.ts "<query>"
import "dotenv/config";
import { runRead } from "../src/pipeline/index.js";

const query = process.argv[2];
if (!query) {
  console.error('usage: npx tsx scripts/read.ts "<query>"');
  process.exit(1);
}

const started = Date.now();
const { readId, verdict, costUsd } = await runRead(query);
console.log(JSON.stringify(verdict, null, 2));
console.log(`\n── read ${readId} — $${costUsd.toFixed(4)} — ${((Date.now() - started) / 1000).toFixed(1)}s`);
