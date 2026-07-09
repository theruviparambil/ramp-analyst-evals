/**
 * Backend selector. RAMP_MODE=live routes tools to the real Ramp MCP (a
 * documented stub); anything else uses the local synthetic fixture. This is the
 * only place that decides which surface the agent talks to.
 */

import { createFixtureBackend } from "./fixture-backend.js";
import { createLiveBackend } from "./live-backend.js";
import type { RampToolSurface } from "./tools.js";

export function selectBackend(mode = process.env.RAMP_MODE): RampToolSurface {
  return mode === "live" ? createLiveBackend() : createFixtureBackend();
}

export { createFixtureBackend, createLiveBackend };
