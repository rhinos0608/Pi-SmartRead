// Boolean query parser & evaluator — moved verbatim from search-tool.ts
// (Phase B split). search-tool.ts re-exports the public names so existing
// `search-tool.js` import paths keep working.

// ── Boolean query parser & evaluator ──────────────────────────────────

export interface BooleanExpression {
  kind: "term" | "phrase" | "not" | "and" | "or";
  value?: string;
  left?: BooleanExpression;
  right?: BooleanExpression;
  expr?: BooleanExpression;
}

type BooleanToken =
  | { type: "word" | "phrase" | "eof"; value: string }
  | { type: "op"; value: "AND" | "OR" | "NOT" }
  | { type: "paren"; value: "(" | ")" };

function tokenize(query: string): BooleanToken[] {
  const tokens: BooleanToken[] = [];
  let i = 0;
  while (i < query.length) {
    if (/\s/.test(query[i]!)) {
      i++;
      continue;
    }
    if (query[i] === "(" || query[i] === ")") {
      tokens.push({ type: "paren", value: query[i] as "(" | ")" });
      i++;
      continue;
    }
    if (query[i] === '"') {
      let j = i + 1;
      while (j < query.length && query[j] !== '"') j++;
      tokens.push({ type: "phrase", value: query.slice(i + 1, j) });
      i = j + 1;
      continue;
    }
    let j = i;
    while (
      j < query.length &&
      !/\s/.test(query[j]!) &&
      query[j] !== "(" &&
      query[j] !== ")" &&
      query[j] !== '"'
    ) {
      j++;
    }
    const word = query.slice(i, j);
    const upper = word.toUpperCase();
    if (upper === "AND" || upper === "OR" || upper === "NOT") {
      tokens.push({ type: "op", value: upper as "AND" | "OR" | "NOT" });
    } else {
      tokens.push({ type: "word", value: word });
    }
    i = j;
  }
  tokens.push({ type: "eof", value: "" });
  return tokens;
}

/**
 * Parse a boolean query string into an expression AST.
 *
 * Grammar (precedence: NOT > AND > OR):
 *   expression := or_expr
 *   or_expr := and_expr ("OR" and_expr)*
 *   and_expr := not_expr ("AND"? not_expr)*
 *   not_expr := "NOT" not_expr | primary
 *   primary := "(" expression ")" | phrase | term
 *   phrase := '"' [^"]* '"'
 *   term := [^\s()"]+
 */
export function parseBooleanQuery(query: string): BooleanExpression {
  const trimmed = query.trim();
  if (!trimmed) return { kind: "term", value: "" };

  const tokens = tokenize(trimmed);
  let pos = 0;

  const peek = (): BooleanToken => tokens[pos] ?? { type: "eof", value: "" };
  const consume = (): BooleanToken => tokens[pos++] ?? { type: "eof", value: "" };

  const parseOr = (): BooleanExpression => {
    let left = parseAnd();
    while (peek().type === "op" && (peek() as { value: string }).value === "OR") {
      consume();
      const right = parseAnd();
      left = { kind: "or", left, right };
    }
    return left;
  };

  const parseAnd = (): BooleanExpression => {
    // Leading OR/AND: treat as just the right operand
    if (peek()?.value?.toUpperCase() === "OR" || peek()?.value?.toUpperCase() === "AND") {
      consume(); // skip the operator
    }
    let left = parseNot();
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const token = peek();
      if (token.type === "eof") break;
      if (token.type === "op" && (token as { value: string }).value === "OR") break;
      if (token.type === "paren" && (token as { value: string }).value === ")") break;

      // Consume explicit AND if present
      if (token.type === "op" && (token as { value: string }).value === "AND") {
        consume();
      }

      const next = peek();
      if (
        (next.type === "op" && (next as { value: string }).value === "NOT") ||
        next.type === "word" ||
        next.type === "phrase" ||
        (next.type === "paren" && (next as { value: string }).value === "(")
      ) {
        const right = parseNot();
        left = { kind: "and", left, right };
      } else {
        break;
      }
    }
    return left;
  };

  const parseNot = (): BooleanExpression => {
    if (peek().type === "op" && (peek() as { value: string }).value === "NOT") {
      consume();
      return { kind: "not", expr: parseNot() };
    }
    return parsePrimary();
  };

  const parsePrimary = (): BooleanExpression => {
    if (peek().type === "paren" && (peek() as { value: string }).value === "(") {
      consume();
      const expr = parseOr();
      // Consume closing paren if present (unmatched paren is tolerated)
      if (peek().type === "paren" && (peek() as { value: string }).value === ")") {
        consume();
      }
      return expr;
    }
    if (peek().type === "phrase") {
      const t = consume() as { value: string };
      return { kind: "phrase", value: t.value };
    }
    if (peek().type === "word") {
      const t = consume() as { value: string };
      return { kind: "term", value: t.value };
    }
    // Should not reach here with well-formed input; consume and return empty
    consume();
    return { kind: "term", value: "" };
  };

  return parseOr();
}

/** Evaluate a parsed boolean expression against a line of text. */
export function evaluateBooleanExpression(
  expr: BooleanExpression,
  line: string,
  caseSensitive: boolean,
): boolean {
  switch (expr.kind) {
    case "term":
    case "phrase": {
      // Empty term matches nothing (handles empty/whitespace-only queries)
      if (!expr.value) return false;
      const haystack = caseSensitive ? line : line.toLowerCase();
      const needle = caseSensitive ? expr.value! : expr.value!.toLowerCase();
      return haystack.includes(needle);
    }
    case "not": {
      // Bare NOT with no operand matches nothing
      if (!expr.expr || (expr.expr.kind === "term" && !expr.expr.value)) return false;
      return !evaluateBooleanExpression(expr.expr!, line, caseSensitive);
    }
    case "and":
      return (
        evaluateBooleanExpression(expr.left!, line, caseSensitive) &&
        evaluateBooleanExpression(expr.right!, line, caseSensitive)
      );
    case "or":
      return (
        evaluateBooleanExpression(expr.left!, line, caseSensitive) ||
        evaluateBooleanExpression(expr.right!, line, caseSensitive)
      );
  }
}
