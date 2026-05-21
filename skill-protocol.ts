/**
 * skill:// protocol handler.
 *
 * Resolves skill://<skill-name>/<file> by reading from
 *   ~/.pi/agent/skills/<name>/<file>
 */

import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import type { UrlHandler, UrlSourceInfo } from "./internal-url-router.js";

function defaultSkillBase(): string {
	return join(homedir(), ".pi", "agent", "skills");
}

/** Read a skill file from ~/.pi/agent/skills/<name>/<file>. */
export async function resolveSkillUrl(
	url: string,
	base?: string,
): Promise<{ text: string; sourceInfo: UrlSourceInfo }> {
	// skill://semantic-compression/SKILL.md → skill, semantic-compression, SKILL.md
	const match = /^skill:\/\/([^/]+)\/(.*)$/.exec(url);
	if (!match) {
		throw new Error(`Invalid skill URL: ${url}`);
	}
	const name = match[1]!;
	const file = match[2] ?? "";
	const basePath = base ?? defaultSkillBase();
	const filePath = join(basePath, name, file);

	// Prevent path traversal: reject any resolved path outside the skill base
	const resolved = resolve(filePath);
	const resolvedBase = resolve(basePath);
	if (!resolved.startsWith(resolvedBase + sep)) {
		throw new Error(`Invalid skill path: traversal detected in ${url}`);
	}

	let text: string;
	try {
		text = await readFile(resolved, "utf-8");
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(`skill://${name}/${file}: ${msg}`);
	}

	return {
		text,
		sourceInfo: { scheme: "skill", path: url },
	};
}

export const skillHandler: UrlHandler = {
	scheme: "skill",
	resolve: (url) => resolveSkillUrl(url),
};