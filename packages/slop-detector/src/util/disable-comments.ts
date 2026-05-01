export interface DisableMap {
  lineDisabled(line: number, ruleId: string, pack: string): boolean;
}

const DISABLE_LINE = /slop-detector:disable-line(?:=([^\s*/]+))?/;
const DISABLE_NEXT_LINE = /slop-detector:disable-next-line(?:=([^\s*/]+))?/;

export function buildDisableMap(text: string): DisableMap {
  const lines = text.split("\n");
  const sameLine = new Map<number, Set<string>>();
  const nextLine = new Map<number, Set<string>>();

  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1;
    const same = lines[i].match(DISABLE_LINE);
    if (same) addTokens(sameLine, lineNumber, same[1]);

    const next = lines[i].match(DISABLE_NEXT_LINE);
    if (next) addTokens(nextLine, lineNumber + 1, next[1]);
  }

  return {
    lineDisabled(line, ruleId, pack) {
      return tokenMatches(sameLine.get(line), ruleId, pack) || tokenMatches(nextLine.get(line), ruleId, pack);
    },
  };
}

function addTokens(map: Map<number, Set<string>>, line: number, raw: string | undefined): void {
  const set = map.get(line) ?? new Set<string>();
  if (raw === undefined) {
    set.add("*");
  } else {
    for (const tok of raw.split(",")) {
      const trimmed = tok.trim();
      if (trimmed) set.add(trimmed);
    }
  }
  map.set(line, set);
}

function tokenMatches(tokens: Set<string> | undefined, ruleId: string, pack: string): boolean {
  if (!tokens) return false;
  if (tokens.has("*")) return true;
  if (tokens.has(ruleId)) return true;
  if (tokens.has(pack)) return true;
  return false;
}
