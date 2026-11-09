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
- **Inside the package.** `@udibo/oauth2` ships its own skill in its npm tarball
  under `skills/`, matching the installed version. This repository pulls that
  copy in rather than writing its own (see
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

- **Fields.** Only the specification's fields: `name` and `description`
  (required), and `license`, `compatibility`, `metadata` and `allowed-tools`.
  Anything else goes under `metadata`, whose values must be strings, so quote
  version numbers.
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
- **References.** Every relative link, and every inline path under
  `references/`, `assets/` or `scripts/`, resolves to a file inside the skill.
  No symbolic links, and LF line endings.

A skill made of `SKILL.md` alone is served as that file. A skill with reference
files is served as a `.tar.gz` holding the skill directory, with `SKILL.md` at
its root.

### Safety rules

A skill is instructions someone else's agent will follow, so every Markdown
file in a skill is checked for three things:

1. **No secret in the conversation.** A skill never asks the person to paste,
   share or show a secret, token, key or password, and never runs a command
   that prints one: `echo "$CLIENT_SECRET"`, `cat .env`, `printenv` and the
   like. Secrets stay in files or a secret store that the agent doesn't read
   back.
2. **Every command pins an exact version.** Installing code always fetches it,
   so the rule is that what gets fetched is fixed:
   - no download piped or substituted into a shell or interpreter
     (`curl … | sh`, `bash <(curl …)`, `irm … | iex`), and no script run
     straight from a URL;
   - no moving tag such as `@latest` or `@next`;
   - `npx`, `pnpm dlx`, `yarn dlx`, `bunx`, `npm exec`, `uvx` and
     `npm`/`pnpm`/`yarn`/`bun create` name a package at an exact version
     (`npx create-thing@1.4.2`);
   - `npm install`, `pnpm add`, `yarn add` and `bun add` give every package an
     exact version (`pnpm add @udibo/oauth2@1.2.3`). Installing from a lockfile
     (`pnpm install --frozen-lockfile`) is fine.
3. **Commands are in fenced blocks.** Any command the agent is told to run sits
   in a fenced code block, never in inline code or a bare prose line, so the
   person can see exactly what will run.

These are conservative pattern checks. They back up human review and prove
nothing: they can miss an unsafe instruction written in a way they don't
recognise, and they can flag a safe sentence, which is then reworded. Every
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
`node scripts/fetch-external.ts` downloads each pinned tarball, rejects it unless
its SHA-512 matches `integrity`, and unpacks `skills/<name>/` into `.cache/`
(ignored by git). The build then treats it like any other skill. It fails when
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
  vendored discovery schema (`schemas/`), recomputes every digest, checks the
  plugin manifests list exactly the indexed skills, and checks the CI workflows.
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
  pull request from a fork runs safely. A workflow that names a self-hosted
  runner, uses `pull_request_target`, references `secrets`, or uses an action not
  pinned to a full commit SHA fails `pnpm check`.

## Licence

Licence to be added with the first published skill.
