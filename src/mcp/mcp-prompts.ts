/**
 * MCP Prompts for Pi-SmartRead.
 *
 * Defines prompt templates used by the MCP server. Each prompt has a name,
 * description, and typed arguments.
 */
import type { Prompt } from "@modelcontextprotocol/sdk/types.js";

/**
 * Prompt argument definition.
 */
export interface PromptArg {
  name: string;
  description: string;
  required: boolean;
}

/**
 * All prompts exposed by the Pi-SmartRead MCP server.
 */
export const MCP_PROMPTS: Prompt[] = [
  {
    name: "explain-code",
    description: "Explain how a piece of code works",
    arguments: [
      {
        name: "code",
        description: "The code to explain",
        required: true,
      },
      {
        name: "language",
        description: "Programming language (e.g. typescript, python)",
        required: false,
      },
    ],
  },
  {
    name: "review-diff",
    description: "Review a git diff for potential issues, bugs, and style concerns",
    arguments: [
      {
        name: "diff",
        description: "The git diff content to review",
        required: true,
      },
      {
        name: "language",
        description: "Primary language in the diff",
        required: false,
      },
    ],
  },
  {
    name: "architectural-analysis",
    description: "Perform architectural analysis of a file or module",
    arguments: [
      {
        name: "filePath",
        description: "Path to the file to analyze",
        required: true,
      },
      {
        name: "query",
        description: "Specific aspect to focus on (e.g. data flow, dependencies)",
        required: false,
      },
    ],
  },
  {
    name: "smartread-tool-guide",
    description: "Guide for selecting the right SmartRead retrieval tool for a task",
    arguments: [
      {
        name: "task",
        description: "Retrieval task to plan tool usage for",
        required: true,
      },
    ],
  },
];
