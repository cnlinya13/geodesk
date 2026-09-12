# Architecture

## Runtime boundaries

```
Browser (React/Vite)
        │ same-origin /api proxy
Node.js HTTP API (server/index.ts)
        ├── PostgreSQL pool and migration reader
        ├── server-side model client (real mode only)
        ├── deterministic website/technical/content services
        └── persisted AI-task state and diagnosis/article workflows
```

The regular development runtime listens only on `127.0.0.1:5173` (Web) and `127.0.0.1:8787` (API). Host and Origin checks are intentionally narrow; they are not a substitute for production authentication or authorization.

## Data boundary

The PostgreSQL database is expected to be named `geodesk`. `server/db.ts` loads an optional root `.env.local`, then reads the complete process environment. Its migration directory is resolved from `import.meta.url`, so migration and API commands do not depend on the shell working directory. `checkDatabase()` rejects another database name before schema checks continue.

The browser does not receive database credentials or model keys. Real model calls are server-side and use the configured provider endpoint only after the provider client validates it. Website reads and content checks must retain their existing URL validation and SSRF protections.

## Demo boundary

`npm run demo` starts the unchanged UI through `vite.demo.config.ts` on `127.0.0.1:5174` and a separate `scripts/demo-server.ts` on `127.0.0.1:8788`. The demo server has no imports from `server/db.ts`, model clients, crawlers, or external HTTP libraries. It stores a small fixture in memory and resets on process restart. Its API shapes mirror only the accepted happy-path UI contract needed to demonstrate the MVP workflow; unsupported technical/content checks and PDF generation are explicit no-ops.

## Persistence and tasks

Regular mode persists projects, question sets, answers, articles, audits and AI-task lifecycle rows in PostgreSQL. A request accepts a long operation as a task and the UI observes its persisted state. A service restart must not turn a partial result into a successful result. The synthetic demo intentionally does not claim those persistence guarantees: it is a bounded local fixture for first-run evaluation.

## Extension boundary

The current real provider is primarily Doubao. A future provider adapter should keep API keys server-side, return a common answer/citation shape, preserve evidence provenance, and add cross-provider regression tests. Multi-model selection, regional routing and global monitoring are roadmap work; they must not be described as current architecture until implemented and verified.
