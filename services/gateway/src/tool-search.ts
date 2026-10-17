import type { Tool } from "@modelcontextprotocol/sdk/types.js";

type SearchableTool = Pick<Tool, "name" | "description" | "inputSchema">;

interface RankedTool<T extends SearchableTool> {
  tool: T;
  score: number;
  index: number;
}

const MIN_FUZZY_TOKEN_LENGTH = 5;

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .toLowerCase()
    .trim();
}

function tokens(value: string): string[] {
  return normalize(value).split(/\s+/).filter(Boolean);
}

function editDistanceAtMostOne(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;

  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + Number(i < a.length || j < b.length) <= 1;
}

function tokenMatch(queryToken: string, candidateTokens: Set<string>): number {
  if (candidateTokens.has(queryToken)) return 1;
  if (queryToken.length < MIN_FUZZY_TOKEN_LENGTH) return 0;
  for (const candidate of candidateTokens) {
    if (editDistanceAtMostOne(queryToken, candidate)) return 0.7;
  }
  return 0;
}

function rankTool<T extends SearchableTool>(tool: T, query: string, queryTokens: string[], index: number): RankedTool<T> | undefined {
  if (!queryTokens.length) return { tool, score: 0, index };

  const name = normalize(tool.name);
  const description = normalize(tool.description ?? "");
  const nameTokens = new Set(tokens(tool.name));
  const descriptionTokens = new Set(tokens(tool.description ?? ""));
  let matched = 0;
  let score = 0;

  for (const token of queryTokens) {
    const nameMatch = tokenMatch(token, nameTokens);
    const descriptionMatch = tokenMatch(token, descriptionTokens);
    const match = Math.max(nameMatch, descriptionMatch);
    if (!match) continue;
    matched += 1;
    score += match * (nameMatch ? 10 : 4);
  }

  if (!matched) return undefined;
  const phrase = normalize(query);
  if (name.includes(phrase)) score += 30;
  else if (description.includes(phrase)) score += 15;
  if (matched === queryTokens.length) score += 12;
  score += matched / queryTokens.length;
  return { tool, score, index };
}

export function searchTools<T extends SearchableTool>(tools: T[], query: string, limit: number): T[] {
  const queryTokens = [...new Set(tokens(query))];
  return tools
    .map((tool, index) => rankTool(tool, query, queryTokens, index))
    .filter((entry): entry is RankedTool<T> => entry !== undefined)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map(({ tool }) => tool);
}
