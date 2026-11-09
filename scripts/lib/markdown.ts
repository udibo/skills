export type MarkdownLine = {
  text: string;
  line: number;
  kind: "prose" | "fence-delimiter" | "code";
};

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Classifies each line of a Markdown document as prose, a fence delimiter, or
 * code inside a fenced block. `firstLine` is the 1-based number of the first
 * line, so callers can report positions in the original file.
 */
export function classifyLines(text: string, firstLine = 1): MarkdownLine[] {
  const result: MarkdownLine[] = [];
  let open: { char: string; length: number } | undefined;
  text.split("\n").forEach((raw, index) => {
    const line = firstLine + index;
    const match = FENCE.exec(raw);
    if (open) {
      const closes =
        match?.[1] !== undefined &&
        match[1][0] === open.char &&
        match[1].length >= open.length &&
        raw.slice(match[0].length).trim() === "";
      if (closes) {
        open = undefined;
        result.push({ text: raw, line, kind: "fence-delimiter" });
      } else {
        result.push({ text: raw, line, kind: "code" });
      }
      return;
    }
    if (match?.[1] !== undefined) {
      open = { char: match[1][0] ?? "`", length: match[1].length };
      result.push({ text: raw, line, kind: "fence-delimiter" });
      return;
    }
    result.push({ text: raw, line, kind: "prose" });
  });
  return result;
}

/** Returns prose with inline code spans removed, for checks that must ignore literal code. */
export function withoutInlineCode(prose: string): string {
  return prose.replace(/(`+)[^`]*?\1/g, " ");
}

/** Returns the contents of each inline code span in a prose line. */
export function inlineCodeSpans(prose: string): string[] {
  return [...prose.matchAll(/(`+)([^`]*?)\1/g)].map((match) => (match[2] ?? "").trim());
}
