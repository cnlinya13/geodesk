# GEODesk

[中文](README.cn.md) | English

GEODesk is a workspace for website operators, content teams, and GEO practitioners to monitor, diagnose, and improve visibility in AI search. Its current focus is Chinese-language websites.

It brings fixed question sets, original model answers, citation evidence, website checks, and follow-up monitoring into one workflow. Use it to understand how AI systems describe and cite a website, identify issues worth addressing, and compare results before and after changes.

> This version is a local, single-user MVP. Doubao is the primary real model integration. A synthetic demo is available without model credentials, but the project does not promise improvements in search rankings, recommendation rates, or citation rates. Model selection, regional configuration, and global GEO monitoring remain roadmap items.

## Core workflow

```text
Create a project → Define questions → Initial diagnosis → Checks and optimization tasks → Implement manually → Re-measure with the same scope
```

| Stage | Current functionality |
| --- | --- |
| Project and scope | Manage websites and optimization targets; maintain 20 questions: 10 recommendation, 6 selection, and 4 decision questions; lock questions. |
| Initial diagnosis | Store per-question model answers, citation links, and model information; calculate recommendation and official-site citation rates separately; provide diagnosis reports and PDF functionality. |
| Website checks | Run non-AI technical checks separately from model-assisted content checks, retaining issues and evidence. |
| Optimization tasks | Generate article tasks and content; users publish externally and then confirm publication manually in the workspace. |
| Ongoing monitoring | Start separate monitoring rounds and compare results using the same question scope. |
| State and data | Persist business results and background task states in PostgreSQL, with migrations and task progress queries. |

The current version does not include a complete multi-user account and permission system, automatic publishing, scheduled monitoring by default, or centrally funded model usage. **Do not expose the current API directly to the public internet.**

## Quick start: no model credentials required

### Prerequisites

- Node.js 24; the repository's `.nvmrc` specifies 24.18.0.
- npm 11 or later.
- Download or clone the project, then run the following commands from the `geodesk` project root.

```bash
npm ci
npm run demo
```

Open **http://127.0.0.1:5174**. The demo API uses `127.0.0.1:8788`.

The demo requires no PostgreSQL instance, `.env.local`, or model API key. Installing dependencies may require internet access; the running demo does not request real websites or models. It uses synthetic data stored in memory, which resets when the service restarts.

Try this flow: create a project → generate and confirm 20 questions → view synthetic diagnosis and citations → generate one optimization task and article body → manually confirm publication → complete one synthetic monitoring round.

The demo does not perform real technical checks, content checks, or PDF generation. Those operations are disabled or explicitly reported as unsupported. It demonstrates interactions, not real model performance or database persistence acceptance.

Press `Ctrl+C` in the terminal to stop the demo.

## Real mode: an isolated database and Doubao configuration

### 1. Install and configure

In addition to Node.js and npm, real mode requires PostgreSQL. The supplied Compose configuration uses PostgreSQL 16; the current documentation requires PostgreSQL 14 or later for a separately managed database.

```bash
npm ci
cp .env.example .env.local
```

Edit `.env.local`:

- `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`: connection settings for an isolated development database.
- `PGDATABASE`: must be `geodesk`.
- `DOUBAO_API_KEY`, `DOUBAO_MODEL_ID`, `DOUBAO_API_ENDPOINT`: your Doubao service configuration. Real model operations require all three; the endpoint must satisfy the client's HTTPS validation.

Do not commit `.env.local` or configure model keys in the browser. The server also accepts a complete process environment; the file itself is optional.

### 2. Start an isolated PostgreSQL instance

If using Docker Compose:

```bash
docker compose up -d
```

This starts only the database, not the application. The database binds to `127.0.0.1:55432` and uses a dedicated named volume. The current Compose file and environment example supply a matching local demo password, which must not be used as a production credential.

To use a custom password, update `PGPASSWORD` in `.env.local` and supply the same value to Compose through the shell environment variable `GEODESK_POSTGRES_PASSWORD`. Compose does not automatically read `.env.local`; changing a variable also does not change the password of an already initialized database volume.

Without Docker, point the configuration at a PostgreSQL database you have created and confirmed is isolated.

### 3. Migrate, check, and start

After confirming that the target is not a production database, run:

```bash
npm run migrate:db
npm run check:db
npm run dev
```

Migrations change the database schema. `check:db` checks connectivity and existing schema, so migrate before checking on first use. Database-name validation is not a substitute for verifying the target environment yourself.

| Service | Address |
| --- | --- |
| Web | http://127.0.0.1:5173 |
| API | http://127.0.0.1:8787 |

Press `Ctrl+C` to stop the application. With Compose, run `docker compose stop` to stop the database while retaining its data.

## Architecture and data boundaries

```text
Browser: React / TypeScript / Vite
    │ Same-origin /api proxy
Local Node.js HTTP API
    ├── PostgreSQL: projects, questions, diagnosis answers, articles, audit results, and task states
    ├── Doubao: server-side model requests
    └── Website reading: technical and content checks
```

The browser neither connects directly to the database nor holds model API keys. Real mode stores original diagnosis answers and citation evidence; do not commit these business records or database backups to a public repository. Website reading and model requests may process business information entered into a project. Assess provider, regional, and data compliance requirements before use.

Users configure and pay for model accounts, usage, databases, and network services. Any support from Codex for Open Source is for project development and maintenance; it does not imply payment for GEO monitoring model usage.

See the [architecture](docs/architecture.md) and [business rules](docs/business-rules.md) for details.

## Development and verification

After installing dependencies, run:

```bash
npm test
npm run build
npm run smoke:demo
```

- `test`: unit, boundary, and API contract tests; not proof of real model output quality.
- `build`: TypeScript checks and a frontend build; not a complete production deployment.
- `smoke:demo`: automated synthetic workflow checks. Ensure the demo ports are not occupied by another task before running it.
- `preview`: previews only the frontend build; it does not start the real API.

Before release, also audit dependencies and run the public-content scan in a **clean delivery copy**:

```bash
npm audit
npm run check:public
```

`check:public` examines the actual file tree, not only Git ignore rules. It reports development directories containing `node_modules`, `dist`, `.env.local`, or `.git`. Do not delete active configuration or repository history just to pass this check; prepare a separate clean copy instead. Without gitleaks installed, the script runs only custom checks, not a complete credential audit of repository history.

### Current verification limits

- The previous local dependency audit still reported moderate and high severity findings involving `sanitize-html` and `undici`. This documentation update does not fix them; upgrade, run regression checks, and audit again before release.
- Real migration acceptance against an isolated PostgreSQL instance has not yet been completed. Existing unit tests and the demo do not replace it.
- Local Host/Origin validation does not replace production-grade authentication and authorization.

See the [testing guide](docs/testing.md) and [release checklist](docs/release-checklist.md).

## Contributing

Reproducible bug reports, documentation improvements, and focused pull requests are welcome. For changes to business rules or database migrations, explain the data impact and include relevant tests.

- [Contributing guide](CONTRIBUTING.md)
- [Code of conduct](CODE_OF_CONDUCT.md)
- [Security reporting](SECURITY.md): do not post keys, customer data, or exploit details in public issues.
- [Changelog](CHANGELOG.md)

## Roadmap

These capabilities are not yet complete and are not commitments of the current version:

- Replaceable model adapters and user-selected providers.
- Configuration of models, regions, budgets, and monitoring targets.
- Common rules for cross-model answers, citation evidence, and result comparisons.
- Regional and global GEO monitoring.

## License

Project code is available under the [MIT License](LICENSE). Third-party dependencies and the Noto Sans SC font retain their own licenses; see [third-party notices](THIRD_PARTY_NOTICES.md).

`private: true` in `package.json` prevents accidental publication to npm. It does not restrict releasing the code under MIT.
