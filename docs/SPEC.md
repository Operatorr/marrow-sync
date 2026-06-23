# Marrow — Monorepo Specification

> **Status:** Draft v1 · **Scope:** Public AGPL-3.0 monorepo only (`client` + `server` + `shared`).
> The private repo (marketing site, billing, any paid/open-core features) is out of scope here.

Marrow is a sync engine for source code — "Dropbox/Google Drive for developers." A user marks one or
more folders (e.g. their `code/` directory) for sync, and Marrow keeps those folders consistent across
all of that user's machines. It understands developer ignore semantics natively: `.marrowignore`,
`.gitignore` (root and nested), and `.gitkeep`.

This document specifies the structure, responsibilities, data model, protocols, and tooling for the
**public, AGPL-3.0-licensed monorepo**.

---

## 1. Goals and non-goals

### Goals

- A small, fast desktop client (Rust core + React 19 UI via Tauri) that syncs chosen folders.
- A thin, stateless-where-possible backend on Cloudflare Workers (Hono) brokering auth, metadata, and storage access.
- Content-addressed, chunked storage so a one-line change in a large file re-uploads one chunk, not the whole file, with deduplication across files and devices.
- First-class ignore semantics: `.marrowignore`, `.gitignore` (cascading), `.gitkeep`.
- End-to-end type safety between client and server (one TypeScript contract, imported on both sides).
- Fully self-hostable: a developer can clone this repo, supply their own Cloudflare account, and run the whole thing.

### Non-goals (for this repo)

- Multi-user **sharing** / collaboration (deferred; lives behind the open-core boundary, see §11).
- Billing, marketing, account management UI (private repo).
- Real-time collaborative editing / CRDT merge (Marrow syncs files, it does not merge file _contents_).
- Mobile clients.

---

## 2. Tech stack

| Layer        | Choice                                       | Notes                                                                       |
| ------------ | -------------------------------------------- | --------------------------------------------------------------------------- |
| Monorepo     | **pnpm workspaces**                          | No Turborepo, no Bun. Plain `pnpm-workspace.yaml` + workspace protocol.     |
| Client shell | **Tauri 2.x**                                | Small binary, system webview, Rust core.                                    |
| Client UI    | **React 19 + Vite + TypeScript**             | Renders inside Tauri webview.                                               |
| Client core  | **Rust**                                     | File watching, hashing, chunking, local index, transfer. The heavy lifting. |
| Backend      | **Hono** on **Cloudflare Workers**           | Thin JSON API. Hono RPC (`hc`) for type-safe client calls.                  |
| Metadata DB  | **Cloudflare D1** (SQLite) + **Drizzle ORM** | File tree, versions, chunk manifests, devices.                              |
| Blob storage | **Cloudflare R2**                            | Content-addressed chunks. Free egress. Presigned URLs.                      |
| Auth         | **better-auth**                              | GitHub OAuth (primary) + Marrow-issued device tokens.                       |
| Shared types | **`packages/shared`**                        | API contract, sync protocol types, ignore-rule types.                       |

---

## 3. Repository layout

```
marrow/
├── pnpm-workspace.yaml
├── package.json                 # root: scripts, devDeps only, "private": true
├── tsconfig.base.json           # shared TS config, path aliases
├── .gitignore
├── .github/
│   └── workflows/
│       ├── ci.yml               # lint + typecheck + test on PR
│       ├── deploy-server.yml    # wrangler deploy on merge to main
│       └── release-client.yml   # build Tauri bundles on tag
├── LICENSE                      # AGPL-3.0
├── NOTICE
├── README.md
├── SPEC.md                      # this file
│
├── packages/
│   └── shared/                  # @marrow/shared — TS types + protocol contract
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           ├── index.ts
│           ├── protocol.ts      # request/response shapes, sync messages
│           ├── ignore.ts        # ignore-rule types shared by UI display
│           └── constants.ts     # chunk sizes, limits, version
│
├── server/                      # @marrow/server — Hono on Workers
│   ├── package.json
│   ├── tsconfig.json
│   ├── wrangler.toml            # Worker config, D1 + R2 bindings
│   ├── drizzle.config.ts
│   ├── migrations/              # D1 SQL migrations
│   └── src/
│       ├── index.ts             # Hono app entry, exports AppType for RPC
│       ├── auth.ts              # better-auth instance
│       ├── db/
│       │   ├── schema.ts        # Drizzle schema (see §6)
│       │   └── client.ts
│       ├── routes/
│       │   ├── devices.ts
│       │   ├── roots.ts
│       │   ├── changes.ts
│       │   └── chunks.ts        # presign missing/needed chunks
│       ├── middleware/
│       │   ├── auth.ts          # verify device token / session
│       │   └── error.ts
│       └── lib/
│           ├── r2.ts            # presigned URL generation
│           └── clock.ts         # per-root logical sequence
│
└── client/                      # Marrow desktop app (Tauri)
    ├── package.json             # front-end (React) package
    ├── tsconfig.json
    ├── vite.config.ts
    ├── index.html
    ├── src/                     # React 19 UI
    │   ├── main.tsx
    │   ├── App.tsx
    │   ├── api/                 # typed client via hono/client (hc)
    │   ├── views/               # onboarding, roots list, status, settings
    │   └── lib/
    └── src-tauri/               # Rust core
        ├── Cargo.toml
        ├── tauri.conf.json
        ├── build.rs
        └── src/
            ├── main.rs
            ├── commands.rs      # #[tauri::command] surface called from React
            ├── watcher.rs       # filesystem watching (notify crate)
            ├── ignore.rs        # .marrowignore / .gitignore / .gitkeep engine
            ├── chunker.rs       # FastCDC content-defined chunking
            ├── hasher.rs        # BLAKE3 chunk hashing
            ├── index.rs         # local manifest / SQLite index of synced state
            ├── transfer.rs      # presigned PUT/GET to R2
            ├── sync.rs          # reconcile local <-> remote
            └── keychain.rs      # device token in OS secure storage
```

### Naming

Package names use the `@marrow/` scope: `@marrow/shared`, `@marrow/server`. The client front-end can be
`@marrow/client-ui`; the Tauri app product name is set in `tauri.conf.json`.

---

## 4. Workspace wiring (pnpm)

`pnpm-workspace.yaml`:

```yaml
packages:
  - "packages/*"
  - "server"
  - "client"
```

Dependencies on the shared package use the workspace protocol so they always resolve to local source:

```jsonc
// server/package.json and client/package.json
{
  "dependencies": {
    "@marrow/shared": "workspace:*",
  },
}
```

Root `package.json` holds only orchestration scripts and shared dev tooling (TypeScript, ESLint,
Prettier, Vitest). Example scripts:

```jsonc
{
  "private": true,
  "scripts": {
    "dev:server": "pnpm --filter @marrow/server dev",
    "dev:client": "pnpm --filter @marrow/client-ui tauri dev",
    "build": "pnpm -r build",
    "typecheck": "pnpm -r typecheck",
    "lint": "pnpm -r lint",
    "test": "pnpm -r test",
    "db:migrate": "pnpm --filter @marrow/server db:migrate",
  },
}
```

> **Why a monorepo, not three repos:** the client and server are two halves of one sync protocol; they
> version and release together. Keeping them in one workspace lets both import the same `@marrow/shared`
> contract, and lets the React UI import the server's Hono `AppType` for end-to-end type-safe calls
> (change an endpoint → client fails to compile until fixed). The marketing site + billing live in a
> _separate private repo_ because a public AGPL repo cannot also hold closed commercial code.

---

## 5. `packages/shared` — the contract

The single source of truth for anything both sides must agree on. **No runtime dependencies on Node or
browser APIs** — pure types and small pure helpers, so it imports cleanly into both the Worker and the
Vite/React build.

Contents:

- **`protocol.ts`** — request/response DTOs for every endpoint; the sync message shapes (a _commit_, a
  _change entry_, a _chunk manifest_); enums for platform, file mode, deletion tombstones.
- **`ignore.ts`** — types describing resolved ignore state for display in the UI (e.g. "this file is
  excluded by `.gitignore` at `src/`"). The _matching engine itself lives in Rust_ (§8); this is just
  the shared vocabulary.
- **`constants.ts`** — protocol version, default chunk sizing (min/avg/max), max file size, hash
  algorithm identifier, API base paths.

The server additionally exports its Hono `AppType` from `server/src/index.ts`; the client imports it via
`hono/client` to get a fully typed RPC client. (`AppType` is a _type-only_ import, so the client bundle
never pulls in server code.)

---

## 6. Server: data model (Cloudflare D1)

> **Assumption A — single user, multiple devices.** No sharing in this repo. Every row is owned by one
> `user_id`. Sharing tables are deliberately absent (see §11).
>
> **Assumption B — version-capable.** Schema stores per-file version history. The MVP client may only
> ever read the _latest_ version (mirror behavior), but the schema does not need to change to turn on
> history/restore later.

Tables (Drizzle; SQL shown for clarity):

```sql
-- Managed by better-auth: user, session, account, verification.
-- (better-auth owns these; do not hand-edit.)

-- A registered installation of the client. The real unit of auth.
CREATE TABLE device (
  id            TEXT PRIMARY KEY,           -- uuid
  user_id       TEXT NOT NULL REFERENCES user(id),
  name          TEXT NOT NULL,              -- "Alex's MacBook"
  platform      TEXT NOT NULL,              -- macos | windows | linux
  token_hash    TEXT NOT NULL,              -- hash of the device token (never store raw)
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER
);

-- A folder the user syncs. Multiple per user (the "code folder", or several).
CREATE TABLE sync_root (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES user(id),
  name        TEXT NOT NULL,                -- display name
  seq         INTEGER NOT NULL DEFAULT 0,   -- per-root logical clock (see §7)
  created_at  INTEGER NOT NULL
);

-- Logical file at a path within a root. Mutable head pointer.
CREATE TABLE file (
  id                  TEXT PRIMARY KEY,
  sync_root_id        TEXT NOT NULL REFERENCES sync_root(id),
  path                TEXT NOT NULL,        -- POSIX-normalized, relative to root
  current_version_id  TEXT REFERENCES file_version(id),
  deleted             INTEGER NOT NULL DEFAULT 0,  -- tombstone
  updated_seq         INTEGER NOT NULL,     -- root.seq at last change (delta cursor)
  UNIQUE (sync_root_id, path)
);

-- Immutable snapshot of a file's content + metadata.
CREATE TABLE file_version (
  id               TEXT PRIMARY KEY,
  file_id          TEXT NOT NULL REFERENCES file(id),
  size             INTEGER NOT NULL,
  mtime            INTEGER NOT NULL,
  mode             INTEGER,                 -- unix permission bits (executable, etc.)
  created_at       INTEGER NOT NULL,
  created_by       TEXT NOT NULL REFERENCES device(id)
);

-- Ordered chunk list for a version (the file's "recipe").
CREATE TABLE file_chunk (
  version_id  TEXT NOT NULL REFERENCES file_version(id),
  idx         INTEGER NOT NULL,             -- order within file
  chunk_hash  TEXT NOT NULL REFERENCES chunk(hash),
  PRIMARY KEY (version_id, idx)
);

-- Content-addressed blob. One row per unique chunk across the whole user.
CREATE TABLE chunk (
  hash      TEXT PRIMARY KEY,              -- BLAKE3 of plaintext chunk; also the R2 key
  size      INTEGER NOT NULL,
  user_id   TEXT NOT NULL REFERENCES user(id),  -- scope for isolation + GC
  refcount  INTEGER NOT NULL DEFAULT 0     -- number of file_chunk rows referencing it
);
```

Notes:

- **R2 object key = `chunk.hash`** (optionally prefixed by `user_id/` for isolation). The server never
  proxies chunk bytes; it only brokers presigned URLs.
- **Garbage collection:** when a version is superseded/deleted, decrement `refcount`; a periodic job
  deletes R2 objects + `chunk` rows at `refcount = 0`. (Run as a Cron Trigger Worker — out of MVP scope
  but the schema supports it.)
- **Dedup scope** is per-user here (so chunk hashes can't leak existence across users). If end-to-end
  encryption is added later, dedup semantics change — flagged in §12.

---

## 7. Sync protocol

The protocol is **pull-based with a per-root logical clock**. Each `sync_root` has a monotonically
increasing `seq`. Every mutation bumps it and stamps the affected rows. A client tracks the last `seq`
it has fully applied (its _cursor_) and asks for everything since.

### Endpoints (Hono, all under `/api`)

| Method   | Path                                 | Purpose                                                                                            |
| -------- | ------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `*`      | `/api/auth/*`                        | Delegated to better-auth (OAuth, session).                                                         |
| `POST`   | `/api/devices`                       | Register this installation; returns a **device token** (shown once).                               |
| `GET`    | `/api/devices`                       | List the user's devices (for "sign out this laptop").                                              |
| `DELETE` | `/api/devices/:id`                   | Revoke a device.                                                                                   |
| `GET`    | `/api/roots`                         | List sync roots.                                                                                   |
| `POST`   | `/api/roots`                         | Create a sync root.                                                                                |
| `GET`    | `/api/roots/:id/changes?since=<seq>` | Delta: files changed since cursor + their chunk manifests.                                         |
| `POST`   | `/api/chunks/check`                  | Body: list of chunk hashes. Returns which are **missing** + presigned **PUT** URLs for those.      |
| `POST`   | `/api/roots/:id/commit`              | Body: new file versions (path, meta, ordered chunk hashes). Atomically bumps `seq`, updates heads. |
| `POST`   | `/api/chunks/download`               | Body: list of chunk hashes. Returns presigned **GET** URLs.                                        |
| `POST`   | `/api/devices/:id/heartbeat`         | Update `last_seen_at`.                                                                             |

### Upload flow (local change → cloud)

1. Rust core detects change, applies ignore rules, chunks the file (FastCDC), hashes each chunk (BLAKE3), builds the version manifest.
2. `POST /api/chunks/check` with all chunk hashes → server replies with the subset **not already in R2** + presigned PUT URLs.
3. Client uploads only the missing chunks **directly to R2** via presigned PUT. (Dedup means unchanged chunks and chunks shared with other files upload zero bytes.)
4. `POST /api/roots/:id/commit` with the manifest. Server verifies all referenced chunks exist, creates `file_version` + `file_chunk` rows, repoints `file.current_version_id`, bumps `sync_root.seq`, increments `chunk.refcount`.

### Download flow (cloud → other device)

1. Client `GET /api/roots/:id/changes?since=<cursor>` → list of changed files + their chunk manifests + new `seq`.
2. Client diffs against its local index; for chunks it lacks, `POST /api/chunks/download` → presigned GET URLs.
3. Client downloads chunks from R2, reassembles files, writes to disk **respecting local ignore state**, advances its cursor to the returned `seq`.

### Conflict policy

File-level, not content-level. If two devices commit different versions of the same path against the same
base, **last-write-wins for the head pointer**, and the losing side is preserved on the other device as a
conflict copy: `name (conflicted copy from <device>, <date>).ext`. Marrow never merges file _contents_
(that's the user's VCS's job). This keeps the engine simple and predictable for source trees.

### Real-time (post-MVP)

MVP polls `/changes` on an interval + on local activity. A later upgrade replaces polling with a push
channel (Cloudflare **Durable Object** websocket per root) without changing the data model.

---

## 8. Ignore semantics (the differentiator)

Implemented in Rust (`client/src-tauri/src/ignore.ts → ignore.rs`) using the same matching rules as Git.
Recommended crate: [`ignore`](https://crates.io/crates/ignore) (the engine behind ripgrep), which already
implements cascading gitignore semantics, or `gitignore`-compatible glob matching if more control is
needed.

### Files honored

| File            | Location                                        | Meaning                                                                                                   |
| --------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `.gitignore`    | root **and any subfolder**                      | Standard Git ignore patterns. Cascades: a nested `.gitignore` adds/overrides rules for its subtree.       |
| `.marrowignore` | root of a sync root (and optionally subfolders) | Marrow's own ignore list. Same syntax as `.gitignore`.                                                    |
| `.gitkeep`      | any folder                                      | Forces an otherwise-empty directory to be **kept/created** on sync (sync tools normally drop empty dirs). |

### Resolution rules

1. **Cascading match (Git semantics):** for a given path, collect all applicable ignore files from the
   root down to the file's directory. Deeper files take precedence; later patterns within a file override
   earlier ones; `!pattern` re-includes.
2. **`.marrowignore` is layered on top of `.gitignore`.** A path is excluded if matched by _either_
   source. `.marrowignore` may use `!negation` to **re-include** something `.gitignore` excluded (e.g.
   you Git-ignore `dist/` but want Marrow to sync it). This is the one place Marrow can _widen_ the set.
3. **`.gitkeep` exception:** an empty directory containing a `.gitkeep` is always synced (the `.gitkeep`
   file itself is synced, materializing the directory on other devices).
4. **Always-ignored, regardless of config:** `.git/`, Marrow's own local index/state dir, OS junk
   (`.DS_Store`, `Thumbs.db`), and anything over the max file size (see `constants.ts`). These can be
   overridden only by an explicit `!` in `.marrowignore` (except `.git/`, which is never synced).
5. **The ignore files themselves are synced** (they're normal files), so ignore rules stay consistent
   across devices. A device re-evaluates ignore state after receiving an updated ignore file.

### UI surfacing

The resolved state (included / excluded + the file & rule responsible) is exposed to React via a Tauri
command using the `@marrow/shared` `ignore.ts` types, so the app can show _why_ a file is or isn't
syncing — a key trust feature for a tool touching source code.

---

## 9. Content-addressed chunking

- **Chunking:** FastCDC (content-defined chunking) so edits shift only local chunk boundaries. Default
  sizing in `constants.ts` (e.g. min 16 KiB, avg 64 KiB, max 256 KiB — tune empirically against real
  code trees, which are many small files).
- **Hashing:** BLAKE3 over the plaintext chunk. The hash is both the dedup key and the R2 object key.
  (SHA-256 is the conservative alternative; BLAKE3 is faster and fine here since this is not a security
  boundary unless/until E2E encryption is added.)
- **Small files:** files below the min chunk size become a single chunk. Many tiny source files are the
  common case, so the index must be efficient at this.
- **Local index:** the Rust core keeps a local SQLite index mapping `path → (mtime, size, version
manifest)` so re-scans are incremental — only changed files (by mtime/size) get re-chunked.

### Content-integrity trust model (MVP)

The server **does not re-hash uploaded bytes**. At commit it only `HEAD`s R2 to confirm an object exists
at the per-user key `userId/<hash>` and trusts that its bytes actually hash to `<hash>` (it trusts R2's
reported byte length, too). A buggy or malicious client can therefore PUT arbitrary bytes under a hash key
and commit a manifest that references it. The blast radius is **strictly per-user**: chunks are keyed by
`(user_id, hash)`, presigned URLs are `userId/`-scoped, and the `file_chunk → chunk` FK is per-user, so a
corrupt chunk can only corrupt the uploader's own data — it can never poison another user's content or leak
cross-user existence. This is an accepted MVP tradeoff. A future hardening (server-side verification on
upload, or end-to-end encryption with client-verified hashes) would close it; until then clients must treat
reassembled content as self-authored, not server-authenticated.

---

## 10. Auth

- **Human identity:** better-auth with **GitHub OAuth** as the primary provider (the audience all has
  GitHub). Email-OTP optional. _Avoid password+scrypt on the Workers free tier_ — CPU-intensive hashing
  gets killed there; OAuth/OTP sidestep it.
- **Desktop OAuth flow:** the client opens the system browser to the auth URL; on success the server
  redirects to a loopback/deep-link the Tauri app is listening on, handing back a short-lived code the
  app exchanges for a session.
- **Device tokens:** after login, the client calls `POST /api/devices` once to register the
  installation and receive a **long-lived, individually revocable device token**. This token (not the
  web session) authenticates all subsequent sync calls. The raw token is shown to the client once and
  stored only in the **OS secure store** (Keychain / Credential Manager / libsecret) via
  `keychain.rs` — never in a plaintext config file. The server stores only `token_hash`.
- **Revocation:** `DELETE /api/devices/:id` invalidates a device ("sign out my old laptop").

---

## 11. Deferred: the sharing boundary (open-core)

Multi-user **sharing** is intentionally **not** in this repo. It's the most natural paid/open-core
feature, and it lives in the private repo later. Consequences baked into this spec:

- All ownership is single `user_id`; there are no `membership`, `share`, or ACL tables.
- The sync protocol assumes one owner per root.
- When sharing is added, it layers _on top_ (a root gains members; `changes`/`commit` gain an
  authorization check) without restructuring the core tables above.

Keeping this line clean now is what lets the public core stay genuinely useful (full single-user
multi-device sync) while leaving room for the commercial layer.

---

## 12. Open questions / decisions still pending

These don't block the structure but will shape behavior. Tracked here so they're not lost:

1. **History depth.** Schema supports unlimited versions. Policy TBD: keep N versions? Time-bounded?
   Latest-only for MVP? (Affects GC and storage cost.)
2. **End-to-end encryption.** A strong selling point for a code-sync tool, but it breaks cross-user
   chunk dedup and changes the hashing/key model. Decide before GA — retrofitting is painful. If E2E is
   wanted, chunks are encrypted client-side and dedup becomes per-user-only (or convergent, with known
   caveats).
3. **Max file / repo size limits** for the hosted free tier vs. self-host (self-host = unlimited).
4. **Move/rename detection.** Chunk-level dedup makes a rename cheap (same chunks, new path), but
   detecting it as a _rename_ vs delete+add is a nicety to spec for the UI/log.
5. **Real-time transport.** Polling for MVP; Durable Object websockets later.

---

## 13. Build, dev, and CI

### Local development

```bash
pnpm install
pnpm db:migrate          # apply D1 migrations (wrangler)
pnpm dev:server          # wrangler dev — Hono on localhost
pnpm dev:client          # tauri dev — opens the desktop app, Vite HMR for UI
```

### Server deploy

- `server/wrangler.toml` declares the D1 and R2 bindings and the Worker route.
- `deploy-server.yml` runs `wrangler deploy` on merge to `main`. Secrets (`BETTER_AUTH_SECRET`,
  OAuth client secret, R2 access keys for presigning) are **Cloudflare Worker secrets**, never committed.

### Client release

- `release-client.yml` builds Tauri bundles for macOS, Windows, and Linux on a version tag and attaches
  them to a GitHub Release. (Download/distribution UX itself is the private site's job.)

### CI on every PR

- `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r test` (Vitest for TS, `cargo test` for Rust core).
- Secret scanning (e.g. `gitleaks`) — see §14.

---

## 14. Licensing and repo hygiene

- **License:** AGPL-3.0. `LICENSE` at repo root; `NOTICE` for attributions.
- **SPDX headers** on source files: `// SPDX-License-Identifier: AGPL-3.0-only`.
- **The repo is public.** AGPL only confers its protections if the source is readable and runnable.
  Public is the point — for a tool touching users' code, "read the source" _is_ the trust mechanism.
- **No secret is ever committed — including in history.** Use `.gitignore` from the first commit; keep
  all credentials in Worker secrets / OS keychain / env. Run `gitleaks` in CI. If the repo is built
  privately first and flipped public later, audit the _entire history_ (and rotate anything that ever
  touched it) before flipping.
- **AGPL network clause:** anyone running a modified Marrow as a network service must offer their
  modified source to its users. This is the guardrail that lets you self-host freely while making it
  unattractive for someone to run a closed competing service off this code.

---

## Appendix A — request/response sketch (illustrative)

```ts
// packages/shared/src/protocol.ts  (shapes only; names indicative)

export interface ChunkRef {
  hash: string;
  size: number;
}

export interface VersionManifest {
  path: string; // POSIX, relative to root
  size: number;
  mtime: number;
  mode?: number;
  chunks: string[]; // ordered chunk hashes
  deleted?: boolean; // tombstone
}

export interface CommitRequest {
  rootId: string;
  baseSeq: number; // cursor the client committed against (conflict detection)
  versions: VersionManifest[];
}

export interface CommitResponse {
  seq: number; // new root seq after applying
  conflicts: string[]; // paths that became conflict copies, if any
}

export interface ChangesResponse {
  seq: number; // new cursor
  changes: VersionManifest[];
}

export interface ChunkCheckResponse {
  missing: { hash: string; uploadUrl: string }[]; // presigned PUT for absent chunks
}

export interface ChunkDownloadResponse {
  urls: { hash: string; downloadUrl: string }[]; // presigned GET
}
```
