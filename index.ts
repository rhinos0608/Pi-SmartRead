import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createIntentReadTool } from "./intent-read.js";
import { createReadManyTool } from "./read-many.js";

export default function (pi: ExtensionAPI) {
  pi.registerTool(createReadManyTool());
  pi.registerTool(createIntentReadTool());
}