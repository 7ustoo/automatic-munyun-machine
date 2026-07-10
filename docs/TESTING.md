# AMM testing strategy

AMM is a desktop application first. Release confidence therefore starts with
the packaged wrapper and dashboard; Telegram and email are optional delivery
adapters, not the primary test surface.

## Pull-request gate

```bash
npm run check
npm test
npm run test:e2e
cd wrapper && go test ./...
```

`npm run test:e2e` serves the real embedded dashboard against deterministic
local fixtures and drives it with Playwright. It must never contact live
hiring.cafe, Telegram, or Google services.

## Real-service smoke

Before a release, use dedicated test accounts and a separate AMM profile:

- cap the batch at 2–3 jobs;
- disable scheduling and account dedup;
- verify hiring.cafe cards and full descriptions resolve;
- verify the private Telegram test chat receives text and an attachment;
- verify the dedicated Gmail account sends the batch;
- confirm the dashboard, export, Telegram, and email contain the same jobs;
- inspect logs for tokens, chat IDs, and OAuth credentials.

## Clean-machine release check

Test the actual installer in a fresh Windows VM with no Node or Git on PATH.
Complete onboarding, upload a fixture resume, scrape, export, connect optional
channels, restart AMM, reboot Windows, upgrade from the previous release, and
exercise both pause-only and full-wipe uninstall modes.

## Failure injection

Kill AMM during state writes; launch concurrent scrapes; return HTTP 429/500,
timeouts, and malformed JSON from adapters; expire OAuth; corrupt state files;
lock a log file; and remove the network mid-scrape. State should remain
readable, delivery failures should be non-fatal, and the dashboard should show
an actionable error.
