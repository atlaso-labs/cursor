/** Drift-test helper: `bun tests/scrub_runner.ts <inputs.json>` prints, for each input
 *  string, this plugin's `scrubCore` and `scrub` results as JSON. Called by
 *  server/test_scrub_connector_parity.py; never bundled (tests/ is excluded). */
import { readFileSync } from "node:fs";
import { scrub, scrubCore } from "../lib/scrub";

const inputs: string[] = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
process.stdout.write(JSON.stringify(inputs.map((t) => ({ core: scrubCore(t), conn: scrub(t) }))));
