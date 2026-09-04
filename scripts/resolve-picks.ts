// Resolve open picks against Polymarket + print the current track record.
// Run on a schedule (cron) to keep the record fresh. Usage: npx tsx scripts/resolve-picks.ts
import "dotenv/config";
import { resolveOpenPicks, trackRecord } from "../src/track/picks.js";

const { checked, resolved } = await resolveOpenPicks(200);
console.log(`checked ${checked} open picks, newly resolved ${resolved}`);
console.log(JSON.stringify(trackRecord(), null, 2));
