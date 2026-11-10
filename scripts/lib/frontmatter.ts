import { parseDocument } from "yaml";

export type Frontmatter = {
  data: Record<string, unknown>;
  body: string;
  bodyStartLine: number;
};

/**
 * Splits a SKILL.md into its YAML frontmatter and Markdown body.
 * Throws an Error naming the problem when the frontmatter is missing, is not
 * strict YAML, or is not a mapping.
 */
export function parseFrontmatter(text: string): Frontmatter {
  const lines = text.split("\n");
  if (lines[0] !== "---") {
    throw new Error("SKILL.md must start with a '---' line opening the YAML frontmatter");
  }
  const end = lines.indexOf("---", 1);
  if (end === -1) {
    throw new Error("SKILL.md frontmatter has no closing '---' line");
  }
  const document = parseDocument(lines.slice(1, end).join("\n"), {
    strict: true,
    uniqueKeys: true,
    prettyErrors: false,
  });
  const problem = document.errors[0] ?? document.warnings[0];
  if (problem) {
    throw new Error(`frontmatter is not valid YAML: ${problem.message}`);
  }
  const data: unknown = document.toJS();
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("frontmatter must be a YAML mapping");
  }
  return {
    data: data as Record<string, unknown>,
    body: lines.slice(end + 1).join("\n"),
    bodyStartLine: end + 2,
  };
}
