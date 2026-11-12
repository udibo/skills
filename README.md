# Udibo agent skills

Agent skills are instructions a coding agent follows to do a job in your
project. The skills in this repository help an agent put
[Udibo Identity](https://udibo.com) and the `@udibo/oauth2` package into a
project: start a new project on them, add them to an existing project, or move
a project over from another identity provider.

## Skills

| Skill | What it does |
| ----- | ------------ |
| [`udibo-start-project`](skills/udibo-start-project/SKILL.md) | Starts a new Hono web app with sign-in through `@udibo/oauth2`, on the package's local development identity provider with no account needed, and later moves it to a hosted Udibo Identity tenant. |

No version is tagged yet. The three skills under `test/fixtures/` are
placeholders the tests use; they are not guidance, so don't follow them.

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

Install commands will be added here when the first version is tagged.

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
  `udibo-`. Every skill carries the prefix, so its name can't collide with
  another publisher's in an agent's skill list. A name without it is rejected
  with the name to use instead (`name "foo" must start with "udibo-"; rename
  the skill and its directory to "udibo-foo"`). A package's skill is named
  after the package (`udibo-oauth2`); a service skill is named for its job
  (`udibo-identity-new-project`).
- **Licence.** Skills are published under this repository's [MIT licence](LICENSE).
  `license` is optional in the frontmatter; when present it must be `MIT`.
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
- **Files.** Every file is UTF-8 text with no NUL byte, and at most 64 KiB. A
  file that is not text is rejected whatever its extension, so a skill can't
  ship images for now. No `scripts/` directory (a skill ships instructions, not
  code to run), no dotfiles or dot-directories (so no `.env` can ship), no
  symbolic links, no backslash in a file name, and LF line endings in
  `SKILL.md`.

A skill made of `SKILL.md` alone is served as that file. A skill with reference
files is served as a `.tar.gz` holding the skill directory, with `SKILL.md` at
its root.

### Safety rules

A skill is instructions someone else's agent will follow, so every text file in
a skill is checked against the rules below. Every file is text (see _Files_
above), so nothing in a skill escapes them.

Before matching, text is normalised:

- NFKC normalisation;
- invisible format characters removed;
- common Cyrillic and Greek look-alikes, the dotless `ı` and Latin small
  capitals folded to plain Latin letters.

In Markdown:

- list, quote, emphasis and table markers are stripped;
- prose lines that wrap are joined into paragraphs;
- code lines ending in `\`, `|` or `&&` are joined to the next line.

A joined command may span at most 10 lines and 8 KiB. A single line or prose
paragraph may be at most 8 KiB. Anything longer is reported
(`too-long-to-check`) rather than scanned, which keeps the checks linear in file
size. A non-Markdown text file is treated as code throughout.

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

   It never carries a secret literal either: no value that looks like a
   credential (a private key block, a cloud, source-host, chat, payment or
   npm token, a JSON Web Token, a URL with a password in it), and no literal
   value given to a setting or field whose name says it holds a secret
   (`AUTH_CLIENT_SECRET=…`, `"password": "…"`). An empty value, an
   `<angle-bracket>` placeholder or a variable reference is fine.

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
4. **No hidden content.** None of these, because a reviewer cannot see them:
   - Unicode format characters (zero-width and bidi controls, tag characters);
   - private-use characters;
   - blank letters (Hangul filler U+3164, Braille blank U+2800);
   - variation selectors;
   - HTML comments in prose;
   - a Latin word carrying a combining mark, or mixing in look-alike letters
     from another script.

   Skills are written in English for now, and this rule rejects format
   characters outright. That also rules out emoji joined with U+200D, scripts
   that need U+200C or U+200D (such as Hindi, Persian and Arabic), and bidi
   isolates in Hebrew. Script-aware exceptions are not built.

These are conservative pattern checks. They back up human review and prove
nothing: they can miss an unsafe instruction written in a way they don't
recognise, and they can flag a safe sentence, which is then reworded. Every skill
still gets a reviewer reading it as instructions to a stranger's agent.

Not modelled, so left to review:

- commands the pin rule doesn't parse: `git clone` without a pinned ref,
  container images, system package managers (`brew`, `apt`, `winget`), and
  language package managers other than npm, pnpm, Yarn, Bun, uvx and pipx
  (`pip`, `cargo`, `go install`, `gem`, `composer`);
- link targets the link check doesn't parse: link paths containing
  parentheses, and targets in raw HTML (`<a href>`, `<img src>`);
- the fetched cache is trusted by its recorded pin. The build doesn't re-hash
  `.cache/` against the tarball's integrity.

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

### Generated marketplace tree

`.claude-plugin/`, `.cursor-plugin/` and `plugins/` at the repository root are
build output, committed so a tag carries a ready marketplace. Never edit them by
hand. After changing a skill, run `pnpm build` and commit the result;
`pnpm check` fails, naming that command, when the committed tree differs from
what the build produces. They are marked `linguist-generated` in
`.gitattributes`.

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
  `plugin-marketplace/`. It also regenerates the committed marketplace tree at
  the repository root from the same output. With no skills it writes an index whose `skills` array
  is empty.
  It also requires `package.json` and `LICENSE` to agree on the MIT licence
  and the committed marketplace tree to match the build byte for byte.
- `node scripts/check.ts --dist dist` also verifies an existing build.
- `pnpm test` runs the tests, which build the fixtures under `test/fixtures/`.

### Fixture replays

Every skill's steps are replayed by the tests, on GitHub-hosted runners with no
secrets and no model calls, so a skill whose steps stop working fails CI.

- **Conventions a skill follows so it can be replayed.** Every command the
  agent or the person runs is in a fenced block marked `sh` (or `bash`,
  `shell`, `zsh`, `console`). Every file the skill creates is a fenced block
  whose info string names it: ```` ```ts title="app.ts" ````.
- **`scripts/skills.test.ts` runs on every skill.** It requires the skill to
  pass every rule above, and it re-runs the rules on copies of the skill
  broken on purpose (a pinned version removed, a download piped into a shell,
  a secret literal added, the name prefix dropped) to show each copy is
  rejected. Every package a skill installs or runs must be a
  `devDependency` of this repository at exactly the pinned version and be
  named in the skill's `metadata.targets`. That is how the replay tests the
  versions the skill gives, and pnpm's three-day release-age gate
  (`pnpm-workspace.yaml`) then also applies to them. File blocks must stay
  inside the project, and every skill must have a replay in
  `scripts/skill-fixtures/<name>.test.ts`.
- **A replay** (`scripts/skill-fixtures/<name>.test.ts`) lists every command
  in its skill, so a new or changed command fails until the replay covers it.
  It writes the skill's file blocks into a throwaway project under
  `.cache/fixture-projects/` and runs the commands there. Commands that need
  no network run as written. An install from the registry is covered by the
  version check above instead. A long-running command, such as a server,
  starts as written with only its port changed to a free one, and the test
  drives it the way the person would. `scripts/lib/fixture.ts` holds the
  shared pieces.

**Agent-run evaluations are not built.** A later job could have an agent follow
each skill against the same fixture projects. It would need a model API key,
so it would run only after merge or on a maintainer-approved run, never on a
pull request, because a pull request chooses the instructions the agent would
follow. The key and its budget are not decided, so nothing here calls a model.

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

## Releasing

A version is published by a git tag, `vX.Y.Z`, never by a release branch.

1. In a pull request, set `version` in `package.json` to the new `X.Y.Z` and
   merge it to `main` as usual.
2. Tag the merge commit and push the tag:

   ```sh
   git tag vX.Y.Z <merge-commit>
   git push origin vX.Y.Z
   ```

3. The CI workflow runs on the tag. Before the usual check, test and build, it
   fails the run unless the tag is `v` plus exactly the `package.json` version
   (`node scripts/check-release.ts`) and the tagged commit is on `main`.

Neither marketplace manifest carries its own version, so the tag is the
version of a release.

### Installing a release

Claude Code accepts a `#<ref>` suffix on a marketplace, and a tag is a ref.
The marketplace is committed at the repository root (see
[Generated marketplace tree](#generated-marketplace-tree)), so a tag carries it.
Pinning to a release looks like this:

```sh
claude plugin marketplace add udibo/skills#vX.Y.Z
claude plugin install udibo@udibo
```

Verified locally with the Claude Code CLI: `claude plugin validate` passes on
the committed tree, and adding the repository by local path and running
`claude plugin install udibo@udibo` installs the plugin. Not verified until a
first tag exists: adding the marketplace from GitHub with a `#vX.Y.Z` suffix.

## Licence

[MIT](LICENSE), copyright 2026 Udibo.
