# Public release checklist

## Scope and content

- [ ] The delivery tree contains only the intended source, migrations, tests, scripts and public documentation.
- [ ] No `.env*` file except `.env.example`, database dump, evidence directory, customer data, log, screenshot or internal note is present.
- [ ] No personal absolute path, internal product name, symlink escaping the tree or private endpoint is present.
- [ ] README separates current Doubao MVP, synthetic demo and roadmap; it does not promise multi-model or global capabilities.
- [ ] Demo copy says synthetic data, no real model and reset-on-restart; unsupported operations remain explicit.

## License and dependencies

- [ ] `LICENSE` contains the authorized MIT text and `package.json` remains `private: true`.
- [ ] Direct dependency licenses and the Noto font OFL notice are checked against the lock file and bundled assets.
- [ ] Third-party notices do not claim MIT covers dependencies, fonts or user-provided content.

## Verification

- [ ] `npm ci`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] `npm run smoke:demo`
- [ ] `npm run check:public`
- [ ] If and only if an independent PostgreSQL instance is confirmed: `npm run migrate:db` followed by `npm run check:db`.
- [ ] Record whether gitleaks or an equivalent full history scanner was available; the public-tree scan is not a history audit.

## Release hygiene

- [ ] Inspect `git status`, staged diff and the final file list in the actual public checkout.
- [ ] Confirm no commit, push, deployment, remote repository creation or external application submission is implied by local preparation.
- [ ] Update `CHANGELOG.md` only for verified changes.
- [ ] Keep rollback instructions and the exact verification output with the release record.
