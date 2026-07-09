/**
 * Minimal, dependency-free .env loader. Reads KEY=VALUE lines from a .env file
 * in the repo root and sets them on process.env if not already set. Keeps the
 * repo SDK-free and the test path (which needs no keys) untouched.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export function loadDotenv(path = resolve(process.cwd(), ".env")): void {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return; // no .env — rely on the ambient environment
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}
