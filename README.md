# GEODesk

[中文](README.cn.md) | English

**In the age of AI search, what does your website look like in AI's answers?**

Users no longer click through 10 blue links — they ask AI for answers directly. Is your website recommended, cited, or invisible in AI responses? GEODesk is the monitoring and diagnosis workspace built to answer that question, currently focused on Chinese-language websites.

## An example

You run a travel website and wonder: when someone asks Doubao for "family-friendly Dalian travel recommendations", does your site show up? GEODesk asks the model a fixed set of 20 questions and tells you: your site was mentioned in 2 out of 10 recommendation questions, and your official site was never cited; the diagnosis report points out your guides lack citable structured information; you publish 3 new articles following the writing tasks; next round, your recommendation rate rises from 20% to 50%. That is one full GEODesk loop.

## What it solves

- **See yourself through AI's eyes**: real models answer a fixed question set; every original answer, citation link, and model info is kept, producing recommendation and official-site citation rates — no more guessing.
- **Make optimization measurable**: monitoring runs in rounds; one click compares with the previous round, looking only at structural changes (recommendation flips, citation flips, link changes) — the data tells whether your changes worked.
- **From diagnosis to action**: diagnosis reports pinpoint issues, technical and content audits provide evidence, writing tasks produce optimized content, and you confirm manually after publishing externally.
- **Ready out of the box, easy to extend**: models plug in via `ModelAdapter` (Doubao is the first), databases via the `DbAdapter` interface (SQLite bundled; PostgreSQL / MySQL / MariaDB verified pluggable).

## How it differs from traditional SEO tools

| | Traditional SEO tools | GEODesk |
|---|---|---|
| Monitors | Search engine rankings | Recommendations and citations in AI answers |
| Data you get | Rank positions, estimated traffic | Original model answers, citation links, recommendation rates |
| Optimization loop | Keywords, backlinks | Diagnose → writing tasks → round-over-round validation |

## Try it in minutes (no model key needed)

```bash
curl -fsSL https://raw.githubusercontent.com/cnlinya13/geodesk/main/deploy.sh | sudo bash
```

One command deploys everything (Node install, frontend build, systemd service, nginx reverse proxy) — IP access by default, HTTPS with a domain optionally. The demo site uses synthetic data, never touches real websites or models, and resets on restart.

Local try: `npm ci && npm run demo`, then open http://127.0.0.1:5174.

## Feature overview

| Stage | Capabilities |
|---|---|
| Project & question set | Manage websites and optimization targets; 20 locked questions (10 recommendation / 6 selection / 4 decision), immutable once locked |
| Initial diagnosis | Per-question original answers, citation links, model info; recommendation / official-site citation rates; diagnosis reports + PDF export |
| Website checks | Technical audits (non-AI) separated from model-assisted content audits; issues and evidence kept apart |
| Optimization tasks | Generate writing tasks and article bodies; confirm manually after publishing externally |
| Ongoing monitoring | New rounds on the same question set; pairwise comparison of changes |

## Tech

React + TypeScript + Vite frontend; Node 24 native `node:http` server; built-in SQLite database (zero dependencies — the file is the database); pluggable adapters for both models and databases.

## Current status

Local single-user MVP: account system (admin / regular user), Doubao as the first real model, synthetic demo site ready out of the box with no login.

> No promise of improved search rankings, recommendation or citation rates. Do not expose the current API directly to the public internet.

## Roadmap

- More model integrations (DeepSeek, Qwen, ChatGPT… one at a time)
- Multi-user & permissions, scheduled monitoring
- Global GEO monitoring, regional configuration

## Contributing

Open source under the MIT license. Issues and PRs welcome.
