/**
 * Live backend — the documented seam to Ramp's real MCP.
 *
 * The whole point of the RampToolSurface interface is that swapping the fixture
 * for the real thing is a backend change and nothing else: the agent loop, the
 * tool registry, and the eval are untouched. This file is intentionally a stub.
 * Wiring real auth is out of scope (it needs Ramp sandbox credentials), but the
 * env contract and the shape of the integration are spelled out here so the
 * path is obvious to a reviewer.
 *
 * Integration shape (per Ramp's public MCP + agent-tool docs):
 *   - Endpoint:  streamable-HTTP MCP at RAMP_MCP_URL (default demo-mcp.ramp.com).
 *   - Auth:      OAuth 2.0 with PKCE; exchange RAMP_CLIENT_ID / RAMP_CLIENT_SECRET
 *                for a bearer token, refresh on expiry.
 *   - Transport: JSON-RPC `tools/call` over the MCP session; the tool names and
 *                argument schemas already match this repo's registry, so the
 *                results drop straight into the same agent loop.
 *   - Money:     the wire keeps Ramp's real formats (transaction amounts as
 *                strings, bill amounts numeric) — same as the fixture.
 */

import type { RampToolSurface, ToolResult } from "./tools.js";

const REQUIRED_ENV = ["RAMP_MCP_URL", "RAMP_CLIENT_ID", "RAMP_CLIENT_SECRET"];

export function createLiveBackend(): RampToolSurface {
  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  return {
    mode: "live",
    async call(name: string): Promise<ToolResult> {
      return {
        ok: false,
        error:
          `RAMP_MODE=live is a documented stub. Calling "${name}" against the real Ramp MCP requires sandbox credentials: ` +
          `set ${REQUIRED_ENV.join(", ")} (missing: ${missing.join(", ") || "none"}) and implement the OAuth/PKCE + MCP tools/call client in live-backend.ts. ` +
          `The tool names and schemas already match, so no other module changes.`,
      };
    },
  };
}
