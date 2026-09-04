import { readFileSync } from "node:fs";
import { join } from "node:path";

const FIXTURES_DIR = join(process.cwd(), "fixtures");

export function loadFixture<T>(name: string): T {
  const raw = JSON.parse(readFileSync(join(FIXTURES_DIR, `${name}.json`), "utf8"));
  delete raw._meta;
  return raw as T;
}

export const MOCK_DELAY_MS = 500;

export function mockDelay(): Promise<void> {
  return new Promise((r) => setTimeout(r, MOCK_DELAY_MS));
}

/** True when a module is executed directly via its CLI entry (npm run <lens> -- <arg>). */
export function isCliEntry(moduleUrl: string): boolean {
  const argPath = process.argv[1];
  if (!argPath) return false;
  return moduleUrl.endsWith(argPath.split("/").pop()!.replace(/\.js$/, ".ts")) || moduleUrl === `file://${argPath}`;
}
