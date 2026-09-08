# Daily Cattle runtime execution and GitHub visibility

**Decision:** keep Cloudflare Cron Triggers as the authoritative scheduler. Use
Cloudflare's native GitHub integration for builds and deployments, and retain
the existing GitHub production-health workflow as a separate, post-run health
check. Do not move the cattle preparation or promotion schedule to GitHub
Actions.

This note evaluates how a Cloudflare Worker execution could be initiated from,
or represented in, GitHub. It does not change the deployed scheduler.

## Current boundary

`daily-cattle` has two Cloudflare Cron Triggers: preparation at 23:45 UTC and
promotion at 00:00 UTC. The Worker selects the operation from the scheduled
event's cron expression. Cloudflare Cron Triggers are specifically intended to
run a Worker's `scheduled()` handler on a UTC schedule; Cloudflare retains the
100 most recent invocations in Cron Events and has longer-lived queryable
Workers Logs. [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)

The public Worker currently exposes image and metadata routes only. Its
`scheduled()` handler is not an HTTP route, so a GitHub Action cannot invoke it
as-is.

## Option A: GitHub Actions schedules an authenticated Worker endpoint

Add one non-public `POST` route (for example, `/_internal/run`) to the Worker.
It would accept an operation (`prepare` or `promote`), authenticate the
request, then call the same lifecycle functions used by `scheduled()`. Two
scheduled GitHub Action entries would call it at 23:45 and 00:00 UTC, with
`workflow_dispatch` retained for a manual run from the Actions tab.

### Security

- Keep the endpoint `POST`-only and reject every request without valid
  authentication before doing work.
- Store its shared credential as an encrypted Cloudflare Worker secret, not in
  `wrangler.jsonc`; Cloudflare documents secrets as encrypted bindings and
  explicitly advises against storing sensitive values in `vars`.
  [Cloudflare secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- Store the matching value as a repository or production-environment Actions
  secret. GitHub injects an Actions secret only when a workflow explicitly
  references it, and recommends minimum-privilege credentials.
  [GitHub Actions secrets](https://docs.github.com/en/actions/concepts/security/secrets)
- Prefer an HMAC signature over a reusable bearer token: sign the method,
  path, requested operation, and a short-lived timestamp; reject stale
  timestamps. The route should also remain idempotent for a UTC day, because a
  retry or duplicate request must not select two photos.

### Reliability and failure semantics

GitHub documents that scheduled workflow runs can be delayed at high load and
can be dropped; public-repository schedules are also disabled after 60 days of
inactivity. Scheduled workflows run from the default branch, at a minimum
interval of five minutes. [GitHub scheduled events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)

That makes this viable for a best-effort, idempotent daily job, but worse than
the existing platform-native scheduler for a service whose daily UTC rollover
matters. A successful HTTP response proves only that the endpoint completed
according to its response contract; the Action should fail on any non-2xx
response and then fetch `/today.json` to verify the expected intended date and
quality gate. GitHub’s Actions UI provides the execution log and pass/fail
record, but Cloudflare would no longer be the source of scheduling history.

### When to choose it

Choose this only if seeing the *trigger itself* in GitHub Actions is more
important than scheduler reliability, and after adding tests for authorization,
stale signatures, duplicate calls, and failed lifecycle operations. It adds a
production control surface and two secrets.

## Option B: Cloudflare cron dispatches a GitHub workflow

Keep the current Cron Triggers. At the end of each preparation/promotion
attempt, the scheduled handler can use `fetch()` to call GitHub's
`POST /repos/{owner}/{repo}/dispatches` endpoint with a
`repository_dispatch` event and a small result payload (operation, UTC date,
outcome, photo ID, and error category). Workers supports outbound HTTP
requests with `fetch()` from a handler. [Cloudflare Workers Fetch API](https://developers.cloudflare.com/workers/runtime-apis/fetch/)

GitHub documents `repository_dispatch` specifically for external activity that
triggers a workflow. The dispatched workflow runs against the default branch;
the payload is available in `github.event`, and the workflow file must be on
that branch. [GitHub repository_dispatch event](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#repository_dispatch)

### Security

- The Worker needs a GitHub credential. A fine-grained token or GitHub App
  installation token that can create repository dispatches needs **Contents:
  write** for this repository. [GitHub repository dispatch API](https://docs.github.com/en/rest/repos/repos#create-a-repository-dispatch-event)
- Store that credential only as a Cloudflare Worker secret. A GitHub App is
  preferable to a user-owned token when the extra installation-token lifecycle
  is justified; GitHub notes that Apps use fine-grained, short-lived tokens and
  are not tied to a departing user. [GitHub Actions secrets guidance](https://docs.github.com/en/actions/concepts/security/secrets)
- Send no credentials or source-image URLs in the dispatch payload. GitHub
  limits the payload to ten top-level properties and 64 KB.
  [GitHub repository dispatch API](https://docs.github.com/en/rest/repos/repos#create-a-repository-dispatch-event)

### Reliability and failure semantics

This keeps the daily operation on Cloudflare's native scheduler, so the job is
not exposed to GitHub scheduled-workflow delay/drop behavior. However,
`204 No Content` from GitHub means the dispatch event was accepted—not that the
resulting workflow succeeded. Conversely, if the Worker completes the cattle
operation but the GitHub call fails, the business operation still succeeded but
GitHub lacks that record. The Worker should log notification failures and the
GitHub workflow should independently fetch `/today.json` before declaring the
run healthy.

For complete failure representation, the Worker must catch and report both
success and failure outcomes. An unhandled exception cannot send a final
notification. This is additional operational code and still cannot make GitHub
the authoritative audit log; Cloudflare Cron Events and Workers Logs remain
the primary evidence.

### When to choose it

Choose this only if a per-operation GitHub Actions entry is worth the added
GitHub write credential and notification code. It is the better of the two
bridges when Cloudflare must remain the reliable executor. It does not replace
the independent health check, because a report about success is not an
independent verification.

## Native Cloudflare GitHub integration

Workers Builds can connect this Worker to GitHub and automatically build and
deploy on pushes. GitHub then shows Cloudflare build check runs and links their
details back to the Cloudflare build. [Cloudflare GitHub integration](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/github-integration/)

It is a CI/CD integration, not a runtime-execution integration: it does not
invoke `scheduled()`, provide a daily job check run, or turn a Cron Trigger
into a GitHub Action. It can replace manual deployment commands, but it cannot
replace either Cloudflare Cron Triggers or the production-health workflow. For
an existing Worker, Cloudflare's connection flow is **Workers & Pages → Worker
→ Settings → Builds → Connect**; the dashboard Worker name must match the
`name` in the repository's Wrangler configuration. [Cloudflare Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/)

## Recommendation for `daily-cattle`

1. Connect the Worker to GitHub through Workers Builds for automatic deploys on
   pushes to `main`; this is the native integration and gives repository-visible
   deployment checks.
2. Keep the existing two Cloudflare Cron Triggers as the only execution
   scheduler. Their operation is UTC-aligned with Daily Cattle's product
   contract and does not inherit GitHub schedule drops.
3. Keep the production-health GitHub Action as a post-run check. Its expected
   failure state is useful: it shows when today's selection was retained rather
   than freshly promoted, without adding a privileged control endpoint.
4. Do **not** add either runtime bridge now. If exact per-cron GitHub entries
   become a requirement, choose Option B (Cloudflare `repository_dispatch`) and
   implement it with a narrowly scoped GitHub App credential, explicit
   success/failure notifications, and independent endpoint verification.
