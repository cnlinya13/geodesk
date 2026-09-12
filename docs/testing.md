# Testing guide

## Local checks

Run the lowest-cost relevant checks first, then the full public check before release:

```bash
npm test
npm run build
npm run smoke:demo
npm run check:public
```

The Vitest suite covers business rules, UI boundaries, API wire decoders, source/Origin guards, task state transitions, migrations and deterministic audit behavior. It does not call a paid model or assert model quality.

## Synthetic demo acceptance

`npm run smoke:demo` starts the demo if port 8788 is free and verifies the actual Vite shell on port 5174. It then exercises HTTP contracts for:

- project creation;
- 20 questions with 10/6/4 category counts;
- confirmation and locking;
- a 20-answer synthetic diagnosis with citations;
- one optimization task and body;
- manual publish confirmation;
- monitoring round 1 with 20 answers;
- explicit PDF-disabled response and no-external-request status.

The smoke script uses only loopback HTTP. It never creates `.env.local`, connects to PostgreSQL, sends a provider request or reads the source project.

## Database checks

Database checks require an independently confirmed local PostgreSQL instance:

```bash
npm run migrate:db
npm run check:db
```

These commands are intentionally not part of `smoke:demo`. A release report must say whether migration/check were run, against which non-production environment class, and which parts remain unverified when no independent PostgreSQL is available.

## Interpreting failures

Separate targeted failures introduced by a change from pre-existing full-suite failures. A green build does not prove production deployment, real provider quality, external website acceptance or legal clearance. Never paste secrets or full private paths into test artifacts.
