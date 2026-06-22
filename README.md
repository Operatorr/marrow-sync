# Marrow

> A sync engine for source code — "Dropbox/Google Drive for developers."

Marrow keeps one or more chosen folders (e.g. your `code/` directory) consistent
across all of your machines. It understands developer ignore semantics natively:
`.marrowignore`, `.gitignore` (root and nested), and `.gitkeep`.

This is the **public, AGPL-3.0-licensed monorepo** (`client` + `server` +
`packages/shared`). See [`docs/SPEC.md`](docs/SPEC.md) for the full specification.

## Why it's different

- **Content-addressed, chunked storage** (FastCDC + BLAKE3): a one-line change in
  a large file re-uploads one chunk, not the whole file, with deduplication
  across files and devices.
- **First-class ignore semantics**: `.marrowignore`, cascading `.gitignore`,
  `.gitkeep`. The app shows you _why_ a file is or isn't syncing.
- **End-to-end type safety**: one TypeScript contract (`@marrow/shared`) imported
  on both sides, plus the server's Hono `AppType` consumed by the client RPC.
- **Self-hostable**: clone this repo, supply your own Cloudflare account, run the
  whole thing.

## Architecture

| Layer        | Choice                                     |
| ------------ | ------------------------------------------ |
| Monorepo     | pnpm workspaces                            |
| Client shell | Tauri 2.x                                  |
| Client UI    | React 19 + Vite + TypeScript               |
| Client core  | Rust (watch, hash, chunk, index, sync)     |
| Backend      | Hono on Cloudflare Workers                 |
| Metadata DB  | Cloudflare D1 (SQLite) + Drizzle ORM       |
| Blob storage | Cloudflare R2 (content-addressed chunks)   |
| Auth         | better-auth (GitHub OAuth + device tokens) |

## Layout

```
packages/shared/   # @marrow/shared — TS types + protocol contract
server/            # @marrow/server — Hono on Workers (D1 + R2 + Drizzle)
client/            # Marrow desktop app: React UI (@marrow/client-ui) + Rust core (src-tauri)
docs/              # knowledge base / system of record
```

## Develop

```bash
pnpm install
pnpm db:migrate          # apply D1 migrations (wrangler)
pnpm dev:server          # wrangler dev — Hono on localhost
pnpm dev:client          # tauri dev — opens the desktop app, Vite HMR for UI
```

Useful root scripts: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`.

## License

[AGPL-3.0-only](LICENSE). Anyone running a modified Marrow as a network service
must offer their modified source to its users. See [`NOTICE`](NOTICE) for
attributions.
