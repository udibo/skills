import { classifyLines, inlineCodeSpans, withoutInlineCode } from "./markdown.ts";

export type FileReference = { target: string; line: number };

const INLINE_LINK = /!?\[[^\]]*\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
const REFERENCE_DEFINITION = /^ {0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)/;
const SKILL_PATH_SPAN = /^(references|assets|scripts)\/[\w.\-/]+$/;
const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;

/**
 * Lists the local file references in a Markdown document: link and image
 * targets, reference definitions, and inline code spans naming a path under
 * `references/`, `assets/` or `scripts/`. URLs with a scheme and same-page
 * anchors are skipped; any `#fragment` or `?query` is stripped.
 */
export function localReferences(text: string): FileReference[] {
  const found: FileReference[] = [];
  for (const { text: raw, line, kind } of classifyLines(text)) {
    if (kind !== "prose") continue;
    const prose = withoutInlineCode(raw);
    for (const match of prose.matchAll(INLINE_LINK)) {
      found.push({ target: unwrap(match[1] ?? ""), line });
    }
    const definition = REFERENCE_DEFINITION.exec(prose);
    if (definition) found.push({ target: unwrap(definition[1] ?? ""), line });
    for (const span of inlineCodeSpans(raw)) {
      if (SKILL_PATH_SPAN.test(span)) found.push({ target: span, line });
    }
  }
  return found
    .filter(({ target }) => target !== "" && !EXTERNAL.test(target))
    .map(({ target, line }) => ({ target: safeDecode(target.replace(/[?#].*$/, "")), line }))
    .filter(({ target }) => target !== "");
}

function safeDecode(target: string): string {
  try {
    return decodeURI(target);
  } catch {
    return target;
  }
}

function unwrap(target: string): string {
  return target.startsWith("<") && target.endsWith(">") ? target.slice(1, -1) : target;
}
