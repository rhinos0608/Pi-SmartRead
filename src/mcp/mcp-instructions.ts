import {
  SMARTREAD_TOOL_GUIDE_TITLE,
  renderSmartReadToolGuide,
} from "../runtime/tool-guidance.js";
import { getMcpAffordanceSelectors } from "../mcp-registry.js";

/**
 * One-line MCP-surface note: the standalone MCP registry does not expose the
 * Pi-only wrapped `read` tool, so MCP clients use host file reading instead.
 */
export const MCP_READ_NOTE =
  "In standalone MCP the Pi-only wrapped `read` tool is not exposed: use your host's own file reading in place of SmartRead read.";

/**
 * Server `instructions` for the standalone MCP server, so MCP clients
 * (Claude Code, Cursor) receive SmartRead routing guidance at handshake.
 */
export const SMARTREAD_MCP_INSTRUCTIONS = [
  SMARTREAD_TOOL_GUIDE_TITLE,
  MCP_READ_NOTE,
  renderSmartReadToolGuide(undefined, getMcpAffordanceSelectors().general.enabled, getMcpAffordanceSelectors().inspect.enabled, true),
].join("\n");

/** Second argument for `new Server(info, options)`. */
export function buildServerOptions(): {
  capabilities: { tools: object; prompts: object; resources: object };
  instructions: string;
} {
  return {
    capabilities: { tools: {}, prompts: {}, resources: {} },
    instructions: SMARTREAD_MCP_INSTRUCTIONS,
  };
}
