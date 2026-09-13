/**
 * File inspect token-budget admission.
 *
 * Owns ordered section admission for the file pipeline: sections are
 * admitted in render order while cumulative tokens fit; the first
 * over-budget section (and all after it) becomes an omitted notice.
 * Only admitted sections contribute evidence resources — omitted
 * sections authorize nothing. No envelopes, no dispatch.
 */
import type { InspectedResource } from "@rhinos0608/pi-workspace-protocol";
import { estimateTokens, findSectionName, mergeRanges } from "./inspect-runtime.js";

export interface FileBudgetAdmission {
    admittedTexts: string[];
    admittedResources: Map<string, InspectedResource>;
    omittedSections: string[];
    budgetExhausted: boolean;
    usedTokens: number;
}

export function admitFileSections(
    extraSections: string[],
    sectionResources: Array<Map<string, InspectedResource>>,
    usedTokens: number,
    budget: number,
): FileBudgetAdmission {
    const admittedTexts: string[] = [];
    const omittedSections: string[] = [];
    let budgetExhausted = false;
    const admittedResources = new Map<string, InspectedResource>();

    for (let i = 0; i < extraSections.length; i++) {
        const sectionText = extraSections[i]!;
        const tokens = estimateTokens(sectionText);
        if (!budgetExhausted && usedTokens + tokens <= budget) {
            admittedTexts.push(sectionText);
            usedTokens += tokens;
            // Merge this section's resources into admitted set
            for (const [key, val] of sectionResources[i]!) {
                const existing = admittedResources.get(key);
                if (existing) {
                    const merged = mergeRanges([...existing.allowedRanges, ...val.allowedRanges]);
                    admittedResources.set(key, { ...existing, allowedRanges: merged });
                } else {
                    admittedResources.set(key, val);
                }
            }
        } else {
            budgetExhausted = true;
            const sectionName = findSectionName(extraSections, i);
            omittedSections.push(sectionName);
        }
    }

    return { admittedTexts, admittedResources, omittedSections, budgetExhausted, usedTokens };
}

export function assembleFileOutput(
    coreLines: string[],
    admittedTexts: string[],
    omittedSections: string[],
): string[] {
    const finalParts = [...coreLines];
    if (admittedTexts.length > 0) {
        for (const s of admittedTexts) {
            finalParts.push(...s.split("\n"));
        }
    }
    if (omittedSections.length > 0) {
        finalParts.push("");
        for (const name of omittedSections) {
            finalParts.push(`## ${name} (omitted: token budget reached — rerun with higher mapTokens)`);
        }
    }
    return finalParts;
}
