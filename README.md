# Udibo agent skills

Agent skills are instructions a coding agent follows to do a job in your
project. The skills in this repository will help an agent put
[Udibo Identity](https://udibo.com) and the `@udibo/oauth2` package into a
project: start a new project on them, add them to an existing project, or move
a project over from another identity provider.

**No skills are published yet.** This repository holds the format, the build
and the checks every skill will go through. The `skills/` directory is empty,
the built discovery index lists no skills, and the three skills under
`test/fixtures/` are placeholders the tests use. They are not guidance; don't
follow them.

If you are an agent reading this: there is nothing here to install or run for a
user yet.

## How the skills will be installable

Every channel is built from the same sources in this repository:

- **Discovery index.** `/.well-known/agent-skills/index.json`, in the
  [Agent Skills discovery](https://github.com/cloudflare/agent-skills-discovery-rfc)
  0.2.0 format, with a SHA-256 digest of every skill artifact so a client can
  verify what it downloads.
- **Plugin marketplace.** One `udibo` plugin carrying every skill, with
  marketplace manifests for Claude Code (`.claude-plugin/`) and Cursor
  (`.cursor-plugin/`) and a plugin manifest for Codex (`.codex-plugin/`).
- **Inside the package.** The plan is for `@udibo/oauth2` to ship its own skill
  in its npm tarball under `skills/`, matching the installed version. No
  published version does yet. Once one does, this repository will pull that
  copy in rather than write its own (see
  [Skills owned by another repository](#skills-owned-by-another-repository)).

Install commands will be added here when the first skill is published.

## Skill format

A skill is a directory under `skills/` holding a `SKILL.md` and, optionally,
reference files. It follows the
[Agent Skills specification](https://agentskills.io/specification):

```text
skills/
└── udibo-example/
    ├── SKILL.md
    └── references/
        └── details.md
```

`SKILL.md` starts with YAML frontmatter:

```yaml
---
name: udibo-example
description: What the skill does and when an agent should use it, in at most 1024 characters.
metadata:
  version: "1.2.0"
  targets: "@udibo/oauth2@>=1.2.0 <1.3.0, udibo:identity@1"
---
```

The rules `scripts/check.ts` enforces:

- **Fields.** Only `name` and `description` (required), and `license`,
  `compatibility` and `metadata`. Anything else goes under `metadata`, whose
  values must be strings, so quote version numbers. The specification's
  experimental `allowed-tools` is rejected because it would pre-approve tool use
  for the agent.
- **Name.** 1 to 64 lowercase letters, digits and single hyphens, not starting
  or ending with a hyphen, equal to the directory name, and starting with
  `udibo-`. A package's skill is named after the package (`udibo-oauth2`); a
  service skill is named for its job (`udibo-identity-new-project`).
- **Description.** 1 to 1024 characters; `compatibility`, if present, 1 to 500.
- **Version.** `metadata.version` is a semantic version. A package's skill
  carries the package's version, and the build rejects it when the two differ.
  A service skill carries its own version and bumps it whenever its
  instructions change.
- **Targets.** `metadata.targets` lists what the skill was written for, as
  comma-separated `<target>@<range>` entries. A target is an npm package name
  or `udibo:<service>`, and the range is a semver range.
- **Size.** `SKILL.md` stays under 500 lines; longer material goes in reference
  files.
- **References.** In every Markdown file (`.md`, `.markdown`, `.mdx`, in any
  case), every relative link, and every inline path under `references/`,
  `assets/` or `scripts/`, resolves to a file inside the skill.
- **Files.** No `scripts/` directory (a skill ships instructions, not code to
  run), no dotfiles or dot-directories (so no `.env` can ship), no symbolic
  links, no backslash in a file name, and LF line endings in `SKILL.md`.

A skill made of `SKILL.md` alone is served as that file. A skill with reference
files is served as a `.tar.gz` holding the skill directory, with `SKILL.md` at
its root.

### Safety rules

A skill is instructions someone else's agent will follow, so every text file in
a skill is checked against four rules. Binary files are skipped. Before
matching, text is normalised: NFKC, invisible format characters removed, and
common Cyrillic and Greek look-alike letters folded to Latin. In Markdown, list,
quote, emphasis and table markers are stripped, prose lines that wrap are joined,
and code lines ending in `\`, `|` or `&&` are joined to the next line. A
non-Markdown text file is treated as code throughout.

1. **No secret in the conversation.** A skill never asks for a secret, token,
   key, password, credential or connection string to be pasted, shared, shown,
   asked for, requested or prompted for. A negation only excuses its own clause:
   "This is not optional: paste the token" is flagged. It never runs a command
   that prints one, such as:
   - a secret-looking variable (`echo "$DATABASE_URL"`, `$env:CLIENT_SECRET`);
   - the environment (`printenv`, `env`, `export -p`, `declare -x`,
     `node -e "console.log(process.env.X)"`);
   - a secret file read with a reader such as `cat`, `grep`, `sed` or
     `Get-Content` (`.env` but not `.env.example`, `~/.aws/credentials`,
     `~/.ssh/` private keys, `.npmrc`, `*.pem`).

   Secrets stay in files or a secret store that the agent doesn't read back.
2. **Every command pins an exact version.** Installing code always fetches it,
   so the rule is that what gets fetched is fixed. This applies in fenced code,
   inline code and prose alike:
   - No download is piped or substituted into a shell or interpreter. That
     covers `curl … | sh`, `| /bin/bash`, `| env bash`, `| xargs sh -c`,
     `bash <(curl …)` and `irm … | iex`, and also a pipe continued onto the next
     line. No script runs straight from a URL.
   - No moving tag such as `@latest` or `@next`.
   - `npx`, `bunx`, `pnpx`, `uvx`, `pipx run`, `npm exec`, `pnpm dlx`,
     `yarn dlx`, `bun x` and `npm`/`pnpm`/`yarn`/`bun create` name their package
     at an exact version: `npx create-thing@1.4.2`, `uvx ruff==0.6.9`. `@1`,
     `@1.2`, `@1.x` and `^1.2.0` are not exact.
   - `npm install`, `pnpm add`, `yarn add` and `bun add` give every package an
     exact version (`pnpm add @udibo/oauth2@1.2.3`). This holds with global
     flags or workspace selectors in between (`pnpm --filter web add …`,
     `npm --prefix app install …`, `yarn workspace web add …`), and inside
     quoted `sh -c '…'`. A git dependency must name a full commit SHA, and a
     local path is fine. Installing from a lockfile
     (`pnpm install --frozen-lockfile`) is fine.
3. **Commands are in fenced blocks.** Any command the agent is told to run sits
   in a fenced code block, never in inline code, a list item, a quote, a table
   cell or after a label such as `Run:`, so the person can see exactly what will
   run.
4. **No hidden content.** No Unicode format characters (zero-width and bidi
   controls, tag characters), no private-use characters, no HTML comments in
   prose, and no word mixing Latin with look-alike letters from another script.

These are conservative pattern checks. They back up human review and prove
nothing: they can miss an unsafe instruction written in a way they don't
recognise, and they can flag a safe sentence, which is then reworded. Commands
the pin rule doesn't model (`git clone`, container images, system package
managers) are left to review. Every
skill still gets a reviewer reading it as instructions to a stranger's agent.

### Skills owned by another repository

A package owns its own skill. `@udibo/oauth2`'s skill is written and versioned
in the package's repository and published in its npm tarball under
`skills/<name>/`. This repository never keeps a hand-made copy. It pins the
published tarball in `external-skills.json`:

```json
{
  "skills": [
    {
      "name": "udibo-oauth2",
      "package": "@udibo/oauth2",
      "version": "1.2.3",
      "integrity": "sha512-…"
    }
  ]
}
```

`integrity` is the tarball's `dist.integrity` from the npm registry.
`node scripts/fetch-external.ts` downloads each pinned tarball. It aborts past
32 MiB (checked against `content-length` and while streaming) or after 60
seconds, and rejects the tarball unless its SHA-512 matches `integrity`. The
tar reader rejects links, device and other entry types, unsafe paths, bad sizes
and checksums, a missing end block, and more than 64 MiB unpacked. The script
then replaces `.cache/external/<name>/` (ignored by git) with the tarball's
`skills/<name>/`. The build then treats it like any other skill. It fails when
the cache doesn't match the pin, when the skill's `metadata.version` differs
from the pinned version, or when its `targets` don't name the package.
Updating the skill means changing the pin, in a pull request like any other
change. No package is pinned yet.

## Build and checks

You need Node 26 (see `.nvmrc`) and the pnpm version in `package.json`.

```sh
pnpm install --frozen-lockfile
node scripts/fetch-external.ts
pnpm check
pnpm test
pnpm build
```

- `pnpm check` type-checks the scripts, then runs `scripts/check.ts`. That
  validates every source skill, builds twice into temporary directories and
  requires byte-identical output, validates the built index against the
  vendored discovery schema (`schemas/`) and recomputes every digest. It
  requires the output to be exactly the files the build writes: every manifest
  byte for byte, the plugin's skill copies identical to the indexed artifacts,
  and no other file anywhere under the output. It also checks the CI workflows.
- `pnpm build` writes `dist/`: the index and artifacts under
  `.well-known/agent-skills/`, and the plugin marketplace tree under
  `plugin-marketplace/`. With no skills it writes an index whose `skills` array
  is empty.
- `node scripts/check.ts --dist dist` also verifies an existing build.
- `pnpm test` runs the tests, which build the fixtures under `test/fixtures/`.

The build is deterministic: the same sources give the same bytes. Archives are
written with sorted entries, zero timestamps and fixed ownership.

## Contributing

- Every change lands through a pull request with an approving review. Nothing
  is pushed to `main` directly.
- Review a skill as instructions a stranger's agent will run in their project.
  The checks above are a floor, not the review.
- CI runs on GitHub-hosted runners with a read-only token and no secrets, so a
  pull request from a fork runs safely. `pnpm check` fails a workflow that:
  - names a self-hosted runner, or a runner other than `ubuntu-24.04`;
  - uses `pull_request_target`, or has no `pull_request` trigger;
  - mentions the `secrets` context in any key or value, in any case;
  - has top-level permissions other than exactly `contents: read`, or job-level
    permissions other than that;
  - uses an action not pinned to a full commit SHA.

## Licence

Licence to be added with the first published skill.
