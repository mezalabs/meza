export interface ParsedQuery {
  readonly text: string;
  readonly filters: {
    readonly from?: readonly string[];
  };
}

/**
 * Parse a search query string into structured filters + free text.
 * v1 scope: `from:username` + free text only.
 */
export function parseQuery(input: string): ParsedQuery {
  const tokens = input.trim().split(/\s+/);
  const from: string[] = [];
  const textParts: string[] = [];

  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (lower.startsWith('from:') && token.length > 5) {
      from.push(token.slice(5));
    } else {
      textParts.push(token);
    }
  }

  return {
    text: textParts.join(' '),
    filters: from.length > 0 ? { from } : {},
  };
}
