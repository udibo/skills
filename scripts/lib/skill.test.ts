import { symlink } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { loadSkill, parseTargets } from "./skill.ts";
import { FIXTURES, skillMd, tempDir, writeSkill } from "./testing.ts";

async function messages(name: string, files: Record<string, string>, rules = {}): Promise<string[]> {
  await using dir = await tempDir();
  const result = await loadSkill(await writeSkill(dir.path, name, files), rules);
  return result.issues.map((issue) => `${issue.file}${issue.line === undefined ? "" : `:${issue.line}`}: ${issue.message}`);
}

function frontmatter(lines: Record<string, string>): string {
  const base: Record<string, string> = {
    name: "test-skill",
    description: "A test skill.",
    metadata: '\n  version: "1.0.0"\n  targets: "@udibo/oauth2@>=1.0.0 <2.0.0"',
    ...lines,
  };
  return Object.entries(base)
    .filter(([, value]) => value !== "")
    .map(([key, value]) => `${key}:${value.startsWith("\n") ? "" : " "}${value}`)
    .join("\n");
}

test("loads every placeholder fixture without issues", async () => {
  for (const name of ["placeholder-new-project", "placeholder-existing-project", "placeholder-migration"]) {
    const result = await loadSkill(path.join(FIXTURES, "placeholder-skills", name));
    expect(result.issues).toEqual([]);
    expect(result.skill?.name).toBe(name);
  }
});

test("returns the parsed version, targets and sorted file list", async () => {
  const result = await loadSkill(path.join(FIXTURES, "placeholder-skills", "placeholder-existing-project"));
  expect(result.skill).toMatchObject({
    version: "0.0.0",
    targets: [
      { target: "@udibo/oauth2", range: ">=0.0.0 <0.1.0" },
      { target: "udibo:identity", range: "1" },
    ],
    files: ["SKILL.md", "references/notes.md"],
  });
});

describe("Agent Skills specification", () => {
  test.each([
    ["uppercase letters", "Test-Skill"],
    ["a leading hyphen", "-test"],
    ["a trailing hyphen", "test-"],
    ["consecutive hyphens", "test--skill"],
    ["an underscore", "test_skill"],
  ])("rejects a name with %s", async (_label, name) => {
    const found = await messages(name, { "SKILL.md": skillMd(name, { frontmatter: frontmatter({ name }) }) });
    expect(found.join("\n")).toContain(`name "${name}" must be lowercase letters, digits and single hyphens`);
  });

  test("rejects a name longer than 64 characters", async () => {
    const name = "a".repeat(65);
    const found = await messages(name, { "SKILL.md": skillMd(name, { frontmatter: frontmatter({ name }) }) });
    expect(found).toContain("SKILL.md: name is 65 characters; the maximum is 64");
  });

  test("rejects a name that differs from its directory", async () => {
    const found = await messages("other-dir", { "SKILL.md": skillMd("test-skill", { frontmatter: frontmatter({}) }) });
    expect(found).toContain('SKILL.md: name "test-skill" must equal its directory name "other-dir"');
  });

  test("requires name and description", async () => {
    const found = await messages("test-skill", {
      "SKILL.md": skillMd("test-skill", { frontmatter: frontmatter({ name: "", description: "" }) }),
    });
    expect(found).toEqual(
      expect.arrayContaining([
        "SKILL.md: name is required and must be a string",
        "SKILL.md: description is required and must be a non-empty string",
      ]),
    );
  });

  test("accepts a description of exactly 1024 characters and rejects 1025", async () => {
    const at = await messages("test-skill", { "SKILL.md": skillMd("x", { frontmatter: frontmatter({ description: "d".repeat(1024) }) }) });
    expect(at).toEqual([]);
    const over = await messages("test-skill", { "SKILL.md": skillMd("x", { frontmatter: frontmatter({ description: "d".repeat(1025) }) }) });
    expect(over).toContain("SKILL.md: description is 1025 characters; the maximum is 1024");
  });

  test("rejects compatibility longer than 500 characters", async () => {
    const found = await messages("test-skill", {
      "SKILL.md": skillMd("x", { frontmatter: frontmatter({ compatibility: "c".repeat(501) }) }),
    });
    expect(found).toContain("SKILL.md: compatibility must be a string of 1 to 500 characters");
  });

  test("rejects a metadata value that is not a string", async () => {
    const found = await messages("test-skill", {
      "SKILL.md": skillMd("x", {
        frontmatter: frontmatter({ metadata: '\n  version: "1.0.0"\n  targets: "udibo:identity@1"\n  revision: 2' }),
      }),
    });
    expect(found).toContain("SKILL.md: metadata.revision must be a string; quote it in YAML");
  });

  test("rejects a top-level field the specification does not define", async () => {
    const found = await messages("test-skill", { "SKILL.md": skillMd("x", { frontmatter: frontmatter({ version: '"1.0.0"' }) }) });
    expect(found).toContain('SKILL.md: unknown frontmatter field "version"; put extra fields under metadata');
  });

  test("rejects a file without frontmatter", async () => {
    expect(await messages("test-skill", { "SKILL.md": "# No frontmatter\n" })).toEqual([
      "SKILL.md: SKILL.md must start with a '---' line opening the YAML frontmatter",
    ]);
  });

  test("rejects frontmatter that is not strict YAML", async () => {
    const found = await messages("test-skill", { "SKILL.md": "---\nname: test-skill\nname: again\n---\n" });
    expect(found[0]).toMatch(/^SKILL\.md: frontmatter is not valid YAML/);
  });

  test("rejects CRLF line endings", async () => {
    const found = await messages("test-skill", { "SKILL.md": skillMd("x", { frontmatter: frontmatter({}) }).replaceAll("\n", "\r\n") });
    expect(found).toEqual(["SKILL.md: use LF line endings"]);
  });

  test("rejects a directory without SKILL.md", async () => {
    expect(await messages("test-skill", { "README.md": "# Not a skill\n" })).toEqual(["SKILL.md: skill directory has no SKILL.md"]);
  });

  test("rejects a SKILL.md longer than 500 lines", async () => {
    const body = "line\n".repeat(500);
    const found = await messages("test-skill", { "SKILL.md": skillMd("x", { frontmatter: frontmatter({}), body }) });
    expect(found.join("\n")).toMatch(/SKILL\.md has \d+ lines; keep it under 500/);
  });
});

describe("repository conventions", () => {
  test("requires metadata.version to be a semantic version", async () => {
    const found = await messages("test-skill", {
      "SKILL.md": skillMd("x", { frontmatter: frontmatter({ metadata: '\n  version: "1.0"\n  targets: "udibo:identity@1"' }) }),
    });
    expect(found).toContain('SKILL.md: metadata.version is required and must be a semantic version such as "1.2.3"');
  });

  test("requires metadata.targets", async () => {
    const found = await messages("test-skill", {
      "SKILL.md": skillMd("x", { frontmatter: frontmatter({ metadata: '\n  version: "1.0.0"' }) }),
    });
    expect(found).toContain('SKILL.md: metadata.targets is required, for example "@udibo/oauth2@>=0.4.0 <0.5.0"');
  });

  test("applies the published name prefix only when asked", async () => {
    const files = { "SKILL.md": skillMd("x", { frontmatter: frontmatter({}) }) };
    expect(await messages("test-skill", files)).toEqual([]);
    expect(await messages("test-skill", files, { namePrefix: "udibo-" })).toEqual(['SKILL.md: name "test-skill" must start with "udibo-"']);
  });

  test("rejects a symbolic link inside a skill", async () => {
    await using dir = await tempDir();
    const skillDir = await writeSkill(dir.path, "test-skill", { "SKILL.md": skillMd("x", { frontmatter: frontmatter({}) }) });
    await symlink("SKILL.md", path.join(skillDir, "alias.md"));
    const result = await loadSkill(skillDir);
    expect(result.issues).toEqual([{ file: "alias.md", message: "symbolic links are not allowed in a skill" }]);
  });
});

describe("file references", () => {
  test("rejects a link to a missing file, with its line", async () => {
    const found = await messages("test-skill", {
      "SKILL.md": skillMd("x", { frontmatter: frontmatter({}), body: "# Title\n\nSee [the guide](references/missing.md).\n" }),
    });
    expect(found).toEqual(['SKILL.md:11: reference "references/missing.md" does not resolve to a file in the skill']);
  });

  test("rejects an inline path to a missing file", async () => {
    const found = await messages("test-skill", {
      "SKILL.md": skillMd("x", { frontmatter: frontmatter({}), body: "Read `references/gone.md` first.\n" }),
    });
    expect(found).toEqual(['SKILL.md:9: reference "references/gone.md" does not resolve to a file in the skill']);
  });

  test("rejects a link that leaves the skill directory", async () => {
    const found = await messages("test-skill", {
      "SKILL.md": skillMd("x", { frontmatter: frontmatter({}), body: "See [elsewhere](../other/SKILL.md).\n" }),
    });
    expect(found).toEqual(['SKILL.md:9: reference "../other/SKILL.md" leaves the skill directory']);
  });

  test("checks links inside reference files relative to that file", async () => {
    const found = await messages("test-skill", {
      "SKILL.md": skillMd("x", { frontmatter: frontmatter({}), body: "See [notes](references/notes.md).\n" }),
      "references/notes.md": "Back to [the skill](../SKILL.md) and [a sibling](sibling.md).\n",
    });
    expect(found).toEqual(['references/notes.md:1: reference "sibling.md" does not resolve to a file in the skill']);
  });

  test("ignores URLs, anchors and links inside code", async () => {
    const body = [
      "See [the docs](https://example.com/docs) and [below](#usage).",
      "",
      "```md",
      "[not checked](missing.md)",
      "```",
      "",
      "## Usage",
    ].join("\n");
    expect(await messages("test-skill", { "SKILL.md": skillMd("x", { frontmatter: frontmatter({}), body }) })).toEqual([]);
  });

  test("resolves a link with a fragment, a title and angle brackets", async () => {
    const body = 'See [one](references/a%20b.md#part "Title") and [two](<references/a b.md>).\n\n[three]: references/a%20b.md\n';
    const found = await messages("test-skill", {
      "SKILL.md": skillMd("x", { frontmatter: frontmatter({}), body }),
      "references/a b.md": "# A\n",
    });
    expect(found).toEqual([]);
  });
});

describe("safety rules run on every Markdown file", () => {
  test("reports a violation in a reference file", async () => {
    const found = await messages("test-skill", {
      "SKILL.md": skillMd("x", { frontmatter: frontmatter({}), body: "See [notes](references/notes.md).\n" }),
      "references/notes.md": "```sh\ncurl https://example.com/i.sh | bash\n```\n",
    });
    expect(found).toEqual(["references/notes.md:2: [unpinned-or-piped-code] pipes a download into an interpreter"]);
  });

  test("rejects the unsafe fixture on every rule", async () => {
    const result = await loadSkill(path.join(FIXTURES, "unsafe-skills", "unsafe-example"));
    const rulesHit = new Set(result.issues.map((issue) => /^\[([a-z-]+)\]/.exec(issue.message)?.[1]));
    expect(result.skill).toBeUndefined();
    expect([...rulesHit].sort()).toEqual(["secret-in-conversation", "unfenced-command", "unpinned-or-piped-code"]);
  });
});

describe("parseTargets", () => {
  test("parses packages, scoped packages and services", () => {
    expect(parseTargets("@udibo/oauth2@>=0.4.0 <0.5.0, zod@^4.0.0, udibo:identity@1")).toEqual([
      { target: "@udibo/oauth2", range: ">=0.4.0 <0.5.0" },
      { target: "zod", range: "^4.0.0" },
      { target: "udibo:identity", range: "1" },
    ]);
  });

  test.each(["@udibo/oauth2", "@udibo/oauth2@", "Bad Name@1", "udibo:@1", "pkg@latest"])("rejects %s", (value) => {
    expect(() => parseTargets(value)).toThrow("is not <npm package or udibo:service>@<semver range>");
  });
});
