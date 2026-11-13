export type MarkdownLine = {
  text: string;
  line: number;
  kind: "prose" | "fence-delimiter" | "code";
};

/** Fence languages whose blocks hold commands the person or agent runs. */
export const SHELL_LANGUAGES: ReadonlySet<string> = new Set(["sh", "bash", "shell", "zsh", "console"]);

const TITLE = /\btitle="([^"]+)"/;
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

/** A fenced code block: its language, its `title="…"` path if any, its lines with the fence indent removed, and the 1-based line of its first content line. */
export type FencedBlock = { language: string; title: string | undefined; lines: string[]; firstLine: number; indent: number };

/** Every fenced code block in a Markdown document, in order. */
export function fencedBlocks(markdown: string): FencedBlock[] {
  const blocks: FencedBlock[] = [];
  let current: FencedBlock | undefined;
  for (const entry of classifyLines(markdown)) {
    if (entry.kind === "fence-delimiter") {
      if (current) {
        blocks.push(current);
        current = undefined;
      } else {
        const indent = /^ */.exec(entry.text)?.[0].length ?? 0;
        const info = entry.text.trim().replace(/^(`{3,}|~{3,})/, "").trim();
        current = { language: (info.split(/\s+/)[0] ?? "").toLowerCase(), title: TITLE.exec(info)?.[1], lines: [], firstLine: entry.line + 1, indent };
      }
    } else if (entry.kind === "code" && current) {
      current.lines.push(entry.text.replace(new RegExp(`^ {0,${current.indent}}`), ""));
    }
  }
  return blocks;
}
