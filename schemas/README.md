# Vendored schemas

## `agent-skills-discovery-0.2.0.schema.json`

The JSON Schema `scripts/check.ts` validates the built
`/.well-known/agent-skills/index.json` against. Checks read this file and never
fetch a schema over the network.

- **Specification:** Agent Skills Discovery via Well-Known URIs, version 0.2.0
  (updated 2026-03-12), at commit
  [`1bd1167`](https://github.com/cloudflare/agent-skills-discovery-rfc/blob/1bd1167983fa5ac9cd47987710c525308eda1a98/README.md)
  of `cloudflare/agent-skills-discovery-rfc`.
- **Where it comes from:** the specification names the schema URI
  `https://schemas.agentskills.io/discovery/0.2.0/schema.json` and says the URI is
  an opaque identifier that need not resolve. On 2026-11-09 that host did not
  resolve, so no published schema file exists to copy. This file transcribes the
  specification's _Discovery Index_ tables: the required top-level `$schema` and
  `skills`, and each entry's required `name`, `type`, `description`, `url` and
  `digest` with the constraints stated there.
- **Extra fields:** the specification tells clients to ignore unrecognised
  fields, so the schema allows them. The build writes none.
- **Updating:** when a schema file is published at the URI, or the specification
  moves to a new version, replace this file with that version, record its source
  here, and update `DISCOVERY_SCHEMA_URI` in `scripts/lib/outputs.ts`.
