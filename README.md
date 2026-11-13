# Udibo agent skills

Agent skills are instructions a coding agent follows to do a job in your
project. The skills in this repository help an agent put
[Udibo Identity](https://udibo.com) and the `@udibo/oauth2` package into a
project: start a new project on them, add them to an existing project, or move
a project between authorization servers.

Where a skill reaches the choice of authorization server, it offers three
paths with the same depth of help: Udibo Identity, the hosted service, which
Udibo recommends; an authorization server you run yourself on
`@udibo/oauth2`; and migrating between authorization servers, in either
direction. The recommendation is stated once, as Udibo's, with its trade-offs,
and the skill then follows the person's choice. The
[steering rules](#steering-rules) below hold every skill to that.

## Skills

| Skill | What it does |
| ----- | ------------ |
| [`udibo-start-project`](skills/udibo-start-project/SKILL.md) | Starts a new Hono web app with sign-in through `@udibo/oauth2`, either on a hosted Udibo Identity tenant the person creates or on an authorization server they run, starting on the package's local development identity provider with no account needed. |

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
     `~/.ssh/` private keys, `.npmrc`, `*.pem`), or with an inline script
     (`node -e`, `node -p`, `python -c` and the like naming `.env`).

   It never carries a secret literal either: no value that looks like a
   credential (a private key block, a cloud, source-host, chat, payment or
   npm token, a JSON Web Token, an `Authorization: Bearer` or `Basic` value, a
   URL with a password in it), and no literal value given to a setting, field
   or flag whose name says it holds a secret. That covers `NAME=value` in code
   or inline code, quoted `"password": "…"` and `secret = "…"`, unquoted
   `client_secret: …` in YAML, INI, TOML and unlabeled blocks,
   `--client-secret …`, and a fallback such as
   `process.env.SESSION_KEY ?? "…"`. A name counts as a secret when it says
   secret, token, password, passphrase, credential, API, private or access
   key, or has `PASS`, `PWD` or `KEY` as a word (`ENCRYPTION_KEY`), unless it
   says public or publishable or the key is a file, path, ID or the like
   (`KEY_FILE`, `primaryKey`). An empty value, an `<angle-bracket>`
   placeholder or a variable reference is fine.

   Secrets stay in files or a secret store that the agent doesn't read back.
2. **Every command pins an exact version.** Installing code always fetches it,
   so the rule is that what gets fetched is fixed. This applies in fenced code,
   inline code and prose alike:
   - No download is piped or substituted into a shell or interpreter. That
     covers `curl … | sh`, `| /bin/bash`, `| env bash`, `| xargs sh -c`,
     `bash <(curl …)` and `irm … | iex`, and also a pipe continued onto the next
     line. No script runs straight from a URL, and no script a skill downloads
     to a file (`curl -o i.sh …`, `wget …`, `curl … > i.sh`) is then run, in
     the same command or a later one in the same file.
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
   - `pip install`, `pip3 install`, `python -m pip install` and `uv add` give
     every package an exact `==` version. A requirements file (`-r`) is left
     to review.
   - No install or package run names its own registry or index
     (`--registry`, `--index-url`, `-i`, `npm_config_registry=`), because an
     exact version from another registry can be anything.
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
  container images, system package managers (`brew`, `apt`, `winget`),
  language package managers other than npm, pnpm, Yarn, Bun, pip, uv and
  pipx (`cargo`, `go install`, `gem`, `composer`), the contents of a
  requirements file, and a registry set in a config file such as `.npmrc`;
- indirection: a URL or command held in a variable, encoded text, or a
  downloaded script run under another name or from another file;
- quoting the parser doesn't split, such as `pip install 'pkg>=2'`;
- a secret written into prose ("the secret is abc123"), and an unquoted
  `key: value` secret outside a YAML, INI, TOML, text or unlabeled block;
- link targets the link check doesn't parse: link paths containing
  parentheses, and targets in raw HTML (`<a href>`, `<img src>`);
- the fetched cache is trusted by its recorded pin. The build doesn't re-hash
  `.cache/` against the tarball's integrity.

### Steering rules

A skill runs inside someone else's coding agent, so any recommendation it makes
has to be one a person would accept from a colleague: said once, attributed,
with its costs named, and dropped once they choose.

**The vendors' rules come first.** No skill, `description`, `metadata` or
plugin manifest may break
[Anthropic's Software Directory Policy](https://support.claude.com/en/articles/13145358-anthropic-software-directory-policy)
or [OpenAI's plugin guidelines](https://developers.openai.com/plugins/plugin-guidelines.md).
Where a rule below conflicts with them, the vendor's rule wins, and the
recommendation is weakened or removed for that vendor's channel. Before every
tag and every directory submission, both policies are read again and every
skill is checked against them.

The conventions a skill follows so the harness can check it exactly:

- **Paths.** A heading `Paths` (level 2 or 3) with one list item per path,
  each starting with its bold label, `**Hosted: Udibo Identity.**`,
  `**Your own authorization server on @udibo/oauth2.**` and
  `**Migrating between authorization servers.**`, and each linking to the
  section of the skill, or the page, that serves it.
- **The recommendation.** A heading `Udibo's recommendation` (level 2 or 3)
  that says "Udibo recommends …" and has one list item per trade-off,
  labelled `**Cost.**`, `**Leaving.**`, `**Where data is held.**` and
  `**What you run.**`. Cost is stated only as "the hosted service has its own
  prices and self-hosting has its own running costs", with a link to
  `https://www.udibo.com`.
- **The hosted step.** The one section where the person connects the app to
  their own tenant has a heading starting `Hosted path:`, and says the person
  approves it before it runs.
- **Migration skills.** A skill that moves users declares
  `metadata.moves-users` as any of `onto-udibo`, `off-udibo` and
  `between-other-providers`, and lists in `metadata.providers` the providers
  it moves users from or to, by the names in `PROVIDERS`
  (`scripts/lib/steering.ts`).

| Rule | Enforced by |
| ---- | ----------- |
| A skill that mentions the hosted service (the words "Udibo Identity" or a `udibo.com` address) has one Paths section naming all three paths, each linking to what serves it | Harness: the section exists once, has the three labels, each has a link, and every `#anchor` matches a heading. Review: that each target really serves its path |
| Exactly one recommendation, attributed to Udibo, beside the Paths section | Harness: the heading occurs once, says "Udibo recommends", and "recommend", "suggest" and "we advise" appear nowhere else in the skill |
| Trade-offs both ways: cost, leaving, where data is held, what you run | Harness: the four labels are present, each names the hosted service and running your own, and Cost is the fixed sentence with its link. Review: that each statement is true and sourced |
| The recommendation sits in the plan step, before any command, and is never raised again | Harness: the Paths and recommendation sections come before the first shell or file block, and no recommendation words appear elsewhere. Review: that the agent does not raise it again in conversation |
| The person's choice is followed; the skill changes path only when they ask | Review |
| Equal help on every path | Harness: the replay covers every command on every path. Review: depth |
| Nothing hosted happens implicitly | Harness: no shell command names a `udibo.com` host or calls an issuer's `/api/` path; no other code or file block names a `udibo.com` host, except a placeholder such as `{tenant-id}.udibo.com` inside the hosted step; the hosted step says the person approves it; there is at most one |
| `description` and `metadata` stay neutral | Harness: "recommend", "suggest", "prefer", "instead of", "rather than", "better", "best", "always use", "superior" and the like fail in `description`, in every `metadata` value and in the plugin manifests' descriptions. Review: that no trigger is broader than the job |
| No disparagement and no framing in terms of another provider | Harness: "‹word›-style sign-in" (and pages, flows, auth and the like), "clone of", and "like", "alternative to", "similar to", "compared to" or "replacement for" a listed provider fail; a listed provider's name fails outside a migration skill declaring it. Review: tone |
| No absolute claims | Harness: "best", "guaranteed", "impossible", "100%", "unbreakable", "bulletproof", "foolproof", "fully secure" and the like fail ("best-effort" and "best practice" are allowed). Review: every claim against the code and site |
| No prices, plans, trials, discounts or upgrade prompts, and no waitlist | Harness: a currency amount in prose, "free trial", "free tier", "‹name› plan", "pricing", "discount", "promo", "coupon", "upgrade to a paid plan" and the like, a link to a pricing page, and "waitlist" fail. "Upgrade" on its own, as in a password hash that upgrades on next sign-in, is allowed |
| Leaving is supported as well as arriving | Harness: the build fails when a skill declaring `moves-users: onto-udibo` is published without `udibo-migrate-from-udibo`; `udibo-migrate-from-udibo` must declare `off-udibo`, and any other `udibo-migrate-from-…` skill must declare a direction |
| The vendors' rules come first | Harness: the no-recommendation channel below. Review: the re-read of both policies before each tag and submission |

These are pattern checks with the same limits as the safety rules: they keep
the mechanical part of each rule from regressing and leave its judgement to
review. A rule that flags a legitimate sentence is reworded rather than
excused; `scripts/lib/steering.test.ts` lists the sentences each rule must
accept, such as "present a plan" and "the plan step".

#### Channel copies without the recommendation

A channel whose rules do not allow a recommendation gets copies with the
`Udibo's recommendation` section removed (its heading and everything up to the
next heading at the same or a higher level). `pnpm check` builds those copies
on every run and holds them to every other rule, and the tests show each one
keeps the same commands and files, so the replay is unchanged. To write them:

```sh
node scripts/build.ts --channel no-recommendation
```

That writes `dist/channels/no-recommendation/` and leaves the committed
marketplace tree alone. A skill must not link to anything inside the
recommendation section, or that copy's link check fails.

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
  validates every source skill, including the steering rules, builds every
  channel's copies, builds twice into temporary directories and
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
  whose info string names it: ```` ```ts title="app.ts" ````. A package
  manager, package runner, downloader or `node` command in any other block
  (`powershell`, `text`, an unlabeled fence) fails, because the replay would
  not see it.
- **`scripts/skills.test.ts` runs on every skill.** It requires the skill to
  pass every rule above, and it re-runs the rules on copies of the skill
  broken on purpose (a pinned version removed, a download piped into a shell,
  a secret literal added, the name prefix dropped) to show each copy is
  rejected, and does the same for each steering rule (the recommendation
  twice, the Paths section or a path removed, the recommendation after a
  command, a command contacting Udibo, "best", a price, an upgrade prompt,
  "waitlist", a preference word in `description`). Every package a skill installs or runs must be a
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
  starts as written. Where the skill fixes a port, the test records the port
  the program asks for, checks it against the skill, and gives it a free one
  instead, and the test's browser sends the skill's URL to that port. The test
  then drives it the way the person would, following the links on the pages
  it serves. Every process a replay starts has a timeout, is stopped after
  each test (SIGTERM, then SIGKILL), and exits on its own when the test
  process dies. `scripts/lib/fixture.ts` holds the shared pieces.

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
