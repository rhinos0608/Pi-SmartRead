# TEB round 2: repository shortlist (measured 2026-10-12)

Input to task authoring (round-2 plan, Part 1.4). Selection is **not final**: each candidate must
pass a live language-server load check at its pin (clone, start `typescript-language-server`,
confirm cross-file definition and references resolve) before tasks are authored.

## Excluded

- Used in earlier studies: drizzle-orm, tsup, prettier, rxjs, TanStack/query, astro, svelte,
  vue core, material-ui, dayjs, github-readme-stats, axios, babel, docusaurus, three.js, preact.
- Not TypeScript-primary per GitHub metadata: microsoft/TypeScript (reports Go), eslint and
  fastify (report JavaScript).

## Candidates

All MIT, TypeScript-primary, not archived, released within 18 months. Data from the GitHub API at
each pin (`releases/latest` or tags, `commits/{sha}`, `git/trees/{sha}?recursive=1`, pinned
`package.json` and `tsconfig.json`). No tree was truncated. Source TS counts `.ts`/`.tsx`/`.mts`/`.cts`
excluding `.d.ts`, `node_modules`, `dist`, `build`, generated and vendor paths, and test, fixture,
example, playground and benchmark paths (counted separately as test TS).

| Repo | Pin (tag, date, commit) | Source TS | Test TS | Source JS | Layout and config | LSP risk |
|---|---|---:|---:|---:|---|---|
| pmndrs/zustand | v5.0.15, 2026-08-13, `2115efb9e270` | 16 | 17 | 2 | single package, root tsconfig, `exports` map | small surface |
| colinhacks/zod | v4.6.6, 2026-10-10, `284243fb0d65` | 215 | 300 | 7 | npm workspaces (9 package.json), root tsconfig | low |
| ianstormtaylor/slate | slate-react@0.133.4, 2026-10-12, `a98984e489e5` | 195 | 1,234 | 15 | npm workspaces, root tsconfig with project references | project references |
| vuejs/language-tools | v3.3.12, 2026-10-02, `cea069882606` | 171 | 57 | 8 | 11 package.json, root tsconfig with project references | project references |
| vitejs/vite | v8.3.4, 2026-10-08, `b6c20f6a8126` | 179 | 393 | 28 | pnpm monorepo (300 package.json), no root tsconfig | no root tsconfig |
| vitest-dev/vitest | v5.0.3, 2026-09-30, `33cadea62e87` | 524 | 1,517 | 24 | pnpm monorepo (97 package.json), no root tsconfig | no root tsconfig |
| typeorm/typeorm | 1.1.2, 2026-10-08, `a0ea55323662` | 572 | 3,038 | 8 | single package (6 package.json), no root tsconfig | no root tsconfig |
| TanStack/router | release-2026-10-10-0730, 2026-10-10, `c79c620bf479` | 681 | 8,012 | 44 | 323 package.json (examples), root tsconfig | very large tree |
| nestjs/nest | v12.1.1, 2026-09-28, `9feedffde8ef` | 1,468 | 568 | 10 | npm workspaces (52 package.json), root tsconfig | low |

`workspaces` reflects the root `package.json` field only; pnpm workspaces are declared in
`pnpm-workspace.yaml` and show as "pnpm monorepo" from their layout.

## Notes for selection

- No candidate exceeds 2,000 source TS files; the largest is nest (1,468). "Large" therefore means
  nest plus a heavy-tree repository (router or typeorm by total TS), or the size bands are redefined
  before authoring.
- Five candidates carry a language-server risk (project references or no root tsconfig). The load
  check decides whether cross-package reference tasks are feasible in them; tasks must not depend on
  resolution the server cannot provide at the pin.
- A first wave of shortlisting was audited (campaign rule D-85): the audit found three
  non-TypeScript-primary candidates; the remaining facts above were measured directly by the parent
  from the API after the audit could not fetch trees.
