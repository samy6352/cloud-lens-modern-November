# CloudLens v3 — Master Plan and 24-Hour Sprint

> **Created:** 30 Sep 2026 00:45 IST · **Owner:** Ravi Verma · **Status:** sprint in progress (S0, S2, S3, S5 done; S1, S4 partial; S6 next)
> **How to use this file in a new chat:** read sections 1–4 for context, then execute **section 7 (24-hour sprint)** task by task,
> updating the **status tracker (section 12)** as you go. Sections 8–11 are the longer v3 roadmap after the sprint.
> This file deliberately contains **no secrets** — credentials come from the local environment / `.env` (never commit them).

---

## 1. Goal

Turn CloudLens (Azure FinOps dashboard, currently "v2" in this repo) into **v3**: a product that a customer installs **inside their own
Azure subscription with two lines in Cloud Shell**, which on first start **creates its own FOCUS cost exports into a new storage account,
backfills history, loads it, and serves a superfast, premium, interactive dashboard** — with all heavy processing done in PostgreSQL.

Two horizons:
- **24-hour sprint (section 7):** a *v3 preview* built on top of v2 (reuse ~70% of the v2 backend; change only what v3 requires),
  with the **React UI foundation from day 1** (S4) served at `/v2` beside the classic UI.
- **12-week roadmap (sections 8–11):** the full from-scratch-quality v3 (all screens in React, split identities, in-DB pipeline, RLS,
  reconciliation).

---

## 2. Requirements (from Ravi — non-negotiable)

| # | Requirement |
|---|---|
| R1 | Scalable, superfast, super-interactive, premium UI |
| R2 | Deployed inside each **customer's own Azure subscription** |
| R3 | Data source = **Cost Management FOCUS export scheduled to blob** → ingest from blob → dashboard |
| R4 | All permissions granted at deployment by **a few lines of script**; **plain Azure RBAC only** — no EA enrollment / billing-role assignments |
| R5 | **First run of the app** creates the FOCUS export in a **new storage account**, backfills history, then loads |
| R6 | **All processing happens in the database**; the app stays thin |
| R7 | **Low cost per customer** — Azure Data Explorer rejected as too expensive |
| R8 | Speed over freshness: data up to 24 h old is fine; a manual Refresh exists |

## 3. Decisions log

| Date | Decision | Why |
|---|---|---|
| 29 Sep | Evidence-gated approach; every phase ends at a measured gate | Past fixes proved the bottleneck was data shape, not engine |
| 30 Sep | **ADX rejected** | 2 × E2d_v5 + ADX markup ≈ **$540/mo** compute (Central India) |
| 30 Sep | **PostgreSQL Flexible only** | ≈ $73–416/mo; `azure_storage` can read Parquet from blob in-DB |
| 30 Sep | **No EA / billing roles**; subscription or management-group RBAC only | Keep customer install to a few lines |
| 30 Sep | **One FOCUS export per subscription** | Management-group FOCUS exports are not supported |
| 30 Sep | Build a **v3 preview in 24 h on top of v2**, then continue the 12-week roadmap | v2 already has most infra and export plumbing |
| 30 Sep | **React stack from day 1** (React 19 + TS + Vite, TanStack Router/Query/Table/Virtual, ECharts, Tailwind v4 + Radix/shadcn, Framer Motion, cmdk ⌘K) — replaces the vanilla-JS refresh in S4 | No throw-away UI work; every screen built from now on is the v3 screen. Strangler: new UI at `/v2`, classic UI stays at `/` until parity |
| 30 Sep | **First run imports 3 months** (current + 2); earlier months up to 13 are **optional**, chosen by an administrator on Setup (ADR-5) | Ravi. A fresh install shows data after 3 export runs per subscription instead of 13 (measured live ≈ 14 min per month per subscription after the first) |

## 4. Verified platform facts (with sources)

- **Export run API** — `POST {scope}/providers/Microsoft.CostManagement/exports/{name}/run?api-version=2026-06-01`, optional body
  `{"timePeriod":{"from","to"}}`, **max range 1 calendar month** → used for backfill.
  https://learn.microsoft.com/rest/api/cost-management/exports/execute
- **Who may create an export (measured live, 30 Sep 2026):** a managed identity **cannot create or update** a FOCUS export
  (`PUT` → `401 RBACAccessDenied`), even holding an unconditional role-assignment right on the destination storage for 14 min;
  it **can run** one (`POST …/run` → 200) with Cost Management Contributor. The docs require the creator to hold Owner or
  `roleAssignments/write` + `permissions/read` on the storage account. So an operator creates the export once (paused); the app runs it.
- **Exports** — FOCUS dataset, formats CSV(+Gzip) or **Parquet(+Snappy)**, file partitioning always on, `manifest.json` per run,
  overwrite optional; "Export selected dates" allows **13 months** history in 1-month chunks; **new exports can take up to 24 h**; once a
  run starts data lands within ~4 h (often ~15 min). Management-group exports: **EA only, usage only** (no FOCUS).
  https://learn.microsoft.com/azure/cost-management-billing/costs/tutorial-improved-exports
- **Firewalled storage** — export creator needs `Microsoft.Authorization/roleAssignments/write` on the storage account; Cost Management
  gives the export a system MI with Storage Blob Data Contributor; "Allow trusted Azure services" must be on; storage
  `publicNetworkAccess` must be **Enabled (selected networks)**, not Disabled; "Permitted scope for copy operations" = any account.
- **Subscription-scope exports** give **FOCUS only** (no price sheet / reservation details / recommendations datasets).
  https://learn.microsoft.com/cloud-computing/finops/toolkit/hubs/configure-scopes
- **Azure PostgreSQL Flexible (PG 16–18)**: `azure_storage` 1.9 (`blob_list`, `blob_get` with decoder **`parquet`**, auth via the
  **server's managed identity**), `pg_cron` 1.6, `pg_partman` 5.4, `hll`, `tdigest`, `pg_hint_plan`. **No** columnar / pg_duckdb.
  https://learn.microsoft.com/azure/postgresql/extensions/concepts-storage-extension ·
  https://learn.microsoft.com/azure/postgresql/extensions/reference-azure-storage-extension ·
  https://learn.microsoft.com/azure/postgresql/extensions/concepts-extensions-versions
- **Prices** (Azure retail API, Central India, USD PAYG, 730 h): PG B2s ≈ $73 · D2ds_v5 ≈ $183 · E2ds_v5 ≈ $204 · E4ds_v5 ≈ $416;
  App Service Linux B1 ≈ $13–15 · B2 ≈ $29; ADX 2×E2d_v5 incl. markup ≈ $540.

---

## 5. Current state — v2 (what already exists)

**Repo:** `C:\Users\raviverma\OneDrive - Microsoft\Documents\Microsoft Scout\cloud-lens-v2` · branch `main` · remote `backup` →
`https://github.com/samy6352/CloudLensv2.git` (ask Ravi before pushing).
**Size:** 80 Python files / ~36K lines (`app/main.py` 250 KB, 94 routes), ~18K lines vanilla JS, `web/assets/app.css` 5,305 lines,
Chart.js, 21 tabs (list in `web/assets/dashboard.js` ≈ lines 348–381), 168 test files.

### 5.1 Reusable v2 assets (do NOT rebuild these in the sprint)

| v3 need | v2 asset |
|---|---|
| Infra in customer sub | `infra/main.bicep`, `infra/modules/stack.bicep` (807 lines): VNet, PG + blob private DNS, blob private endpoint, PG Flexible (`-PostgresSku Standard_E2ds_v5`, `PremiumV2_LRS`, 3000 IOPS, PG 16), UAMI, App Service, App Insights, Foundry (AI) |
| Entra app automatically | `Microsoft.Graph/applications` + `servicePrincipals` in Bicep |
| Firewall-safe export creation | `storageUserAccessAdmin` role in `stack.bicep`, ABAC condition limits delegation to Storage Blob Data Contributor (`ba92f5b4-…`) |
| Installer | `infra/deploy.ps1` (PowerShell 7; params `-Location -ResourceGroup -PostgresSku -CostScopeAllVisible -EnableExportManagement -SkipFocusExports -SkipCode -WhatIf …`), `infra/preflight.ps1`, `infra/cost-access.ps1`, `infra/grant-cost-access.ps1` (Reader, Cost Management Reader, + Cost Management Contributor with `-EnableExportManagement`) |
| Create/run exports **from the app** | `app/schedules.py`: `create()` (PUT export, `_grant_storage()` for firewalled storage), `run_now()` (POST run with `timePeriod`), `listing()`, `remove()`; `app/capabilities.py` checks export rights |
| Script-created exports | `infra/focus-exports.ps1` (api-version `2025-03-01`, `FocusCost`, `CreateNewReport`, Parquet+Snappy FOCUS `1.0r2` since S2 — was CSV) |
| Manifest-driven loader | `app/exports.py` (reads `manifest.json`, supports `.csv/.csv.gz/.parquet/.snappy.parquet`, Parquet batch 65,536), `app/scopes.py`, `app/staging.py`, `app/derived.py` (CTAS rebuilds) |
| Fast serving tables | `billing_serving`, `hourly_usage`, `usage_signals`, `resource_tags` (last three **uncommitted**) |
| Security default | `AUTH_ALLOW_LOCAL` is opt-in only (`app/auth.py:416`) |
| Benchmarks | `tools/bench_tabs.py`, `tools/_bench_local.py`, `tools/bench-tabs-latest.json` |
| Browser tests | `npm run test:browser` (`tests/run_browser_suites.mjs`), `npm run audit:a11y` |

### 5.2 Uncommitted work at plan time (commit in task S0)
Modified: `.env.example`, `app/ai_billing.py`, `app/esu.py`, `app/exports.py`, `app/jobs.py`, `app/main.py`, `app/resources.py`,
`app/snapshot_cache.py`, `app/tags.py`, `app/uptime.py`, `app/warehouse.py`, several `tests/*`, `tools/bench-tabs-latest.json`,
`web/assets/app.js`, `web/assets/dashboard.js`.
Untracked: `app/hourly_usage.py`, `app/resource_tags.py`, `app/usage_signals.py`, `tests/test_usage_summaries.py`,
plus scratch files `_probe_range.sql`, `tmp_live_probe.py`, `tmp_*.log` (do **not** commit scratch files).

### 5.3 Measured baseline (`tools/bench-tabs-latest.json`, 29 Sep 22:55, local 17M-row estate)
25 endpoints · **3 return 400** (`/api/dashboard/change-analysis`, `/performance`, `/service-health`) · **13 are > 1 s cold** · 6 > 0.3 s warm.

| Endpoint | Cold s | Warm s |
|---|---|---|
| `/api/insights` | **225.70** | **220.59** |
| `/api/dashboard/commitments?days=30` | **101.71** | **97.38** |
| `/api/dashboard/recommendations?days=30` | 33.36 | 0.06 |
| `/api/dashboard/esu?days=30` | 31.27 | 0.06 |
| `/api/dashboard/savings?days=30` | 13.53 | 0.07 |
| `/api/schedules` | 8.27 | 0.06 |
| `/api/dashboard/governance?days=30` | 7.98 | 0.06 |
| `/api/dashboard/rightsizing?days=30` | 6.27 | 0.06 |
| `/api/dashboard/waste?days=30` | 5.97 | **5.88** |
| `/api/dashboard/health` | 2.26 | 0.07 |
| `/api/dashboard/anomalies?days=30` | 2.19 | 2.13 |

### 5.4 Local environment (no secrets here)
- Venv: `C:\Users\raviverma\.venvs\cloudlenstony`
- Tests: set `CLOUDLENS_PG_TEST=localhost`, `CLOUDLENS_PG_USER=postgres`, `PGSSLMODE=disable`, and `PGPASSWORD` **from your local
  environment**, then `python -m pytest`.
- Run app: `python -m uvicorn app.main:app --host 127.0.0.1 --port 8100` (local admin credentials: from local `.env`, not this file).
- Scale environment: rg `CloudLens-Scale`, https://cloudlens-web-scale.azurewebsites.net, PG `cloudlens-postgres-scale` — MCAPS stops
  it nightly: `az postgres flexible-server start -g CloudLens-Scale -n cloudlens-postgres-scale` (~4 min); client IP changes between
  sessions, so a new firewall rule may be needed.

### 5.5 Hard-won lessons (apply everywhere)
1. **Never edit source files while pytest is running** — several tests read/exec source at run time.
2. PostgreSQL **never parallelises `INSERT … SELECT`**; use **`CREATE TABLE AS`** for big builds (2445 s → 925 s measured).
3. **Never benchmark with `SELECT count(*) FROM (…)`** — PostgreSQL elides the aggregates. Use `EXPLAIN (ANALYZE, BUFFERS)` or
   materialise the real result.
4. Default row limits silently truncate (`r.rows()` limit=200 bug) — always paginate explicitly and flag truncation.
5. Disk IOPS matter: P4 (120 IOPS) broke production; use Premium SSD v2 ≥ 3,000 IOPS or ≥ P15.
6. Screens must read **small summary tables**, never the 5.8M-rows/month detail table.

---

## 6. Target architecture (v3)

```
Customer subscription — one resource group
 ├─ Cost Management: 1 FOCUS export per subscription ──Parquet──▶ Storage (exports container, firewalled + trusted services)
 ├─ Storage ──private endpoint──▶ PostgreSQL Flexible (VNet-injected, Entra-only)   ← ALL processing
 │     pg_cron discover manifests → leased loaders (azure_storage parquet → normalise via CTAS → marts) → safe publish
 ├─ Worker (not internet-facing): creates exports, backfills, reconciles with Cost Management, runs migrations
 └─ Web app (App Service, Easy Auth): thin API (calls api.* SQL functions only) + UI
```
Principles: complexity lives in the template, never in customer steps · one ingestion path (everything lands in blob, PG ingests) ·
app moves bytes + renders, SQL computes · screens read marts, line items are drill-down only · zero secrets · every number
reconcilable with Azure · nothing internet-facing holds admin rights.

**Customer install (target):**
```powershell
az account set -s <subscription-id>
iex "& { $(irm https://<host>/install.ps1) } -Location centralindia"      # optional: -Scope <mg-or-sub> -Size small|medium|large
```
**Deployer needs:** Owner on host subscription · Owner/User Access Administrator on the monitored scope · Entra app-registration right
(or an Entra admin pre-creates the app and passes `-EntraClientId`).

**App identity RBAC (assigned automatically):** Reader + Cost Management Contributor on monitored scope · Storage Blob Data Contributor ·
ABAC-limited User Access Administrator on storage (exists) · PG Entra login. **PG server MI:** Storage Blob Data Reader (for `azure_storage`).
**Export MI:** assigned by Cost Management.

**Known subscription-scope limits:** no unused-commitment cost, no price-sheet dataset (FOCUS ListCost/ContractedCost suffice),
reservation recommendations via Advisor (Reader). Optional billing-scope add-on later.

---

## 7. 24-HOUR SPRINT — v3 preview on top of v2  ⟵ START HERE

**Rules for the sprint**
- Work on branch **`v3`**. One commit per task, message ending with
  `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`. Ask Ravi before any `git push`.
- Never edit source while pytest runs. Re-bench with `tools/bench_tabs.py` after S1. Measure with real results (lesson 3).
- Azure test deployments go into a **temporary resource group** (proposed `rg-cloudlens-v3-test` in the CloudLens-Scale subscription,
  Central India) and are **deleted at the end** (≈ $7–10/day). Get Ravi's OK before creating Azure resources.
- If a task overruns its box by > 50 %, stop, record findings in section 12, move on.

### S0 · Freeze and branch (H0–H1)
1. `git status`; commit the in-flight summary-table work (5.2) on `main` as a checkpoint — **exclude** scratch files (`tmp_*`,
   `_probe_range.sql`); add them to `.gitignore` if appropriate.
2. `git switch -c v3`.
3. Run full pytest (env in 5.4) → record pass/fail counts in section 12.
4. Start the app locally, run `tools/bench_tabs.py`, save as `tools/bench-tabs-v3-baseline.json`.
**Done when:** branch `v3` exists, tests green (or known failures listed), baseline saved.

### S1 · Speed: fix the slowest screens (H1–H6)
Targets: **every benched endpoint < 1 s cold and < 300 ms warm; zero 400s.**
1. Profile `/api/insights` (226 s), `/api/dashboard/commitments` (102 s / 97 s warm), `/api/dashboard/waste` (5.9 s warm),
   `/api/dashboard/anomalies` (2.1 s warm), `/api/anomalies/alerts` (1.3 s warm) with `EXPLAIN (ANALYZE, BUFFERS)`; find the source
   module (`app/insights.py`, `app/commitments.py`, `app/waste.py`, `app/anomalies.py`).
2. For each: precompute into a **serving table built during the derived rebuild** (same pattern as `billing_serving`: CTAS, keyed by
   month/subscription, invalidated by data version), and make the endpoint read only that table.
3. Cold paths that call live Azure APIs (recommendations 33 s, ESU 31 s, governance 8 s, rightsizing 6 s, savings 13.5 s):
   warm them in the background after start/load (existing warming in `app/snapshot_cache.py` / browser warming) so the first user never
   pays the cold cost; return cached data with a "refreshing" flag.
4. The three 400s (change-analysis, performance, service-health): determine cause (likely no ARM access locally); return **200 with an
   explicit empty-state payload** (`{"available": false, "reason": …}`) instead of 400; update UI to render the empty state.
5. Tests for each serving table (row-set equality vs the old query on a fixture), re-bench → `tools/bench-tabs-v3-s1.json`.
**Done when:** targets met or each miss explained in section 12.

### S2 · First run creates exports and backfills — inside the app (H6–H10)
Build on `app/schedules.py` (`create`, `run_now`, `_grant_storage`) and `app/capabilities.py`.
1. **Format:** change export body to **Parquet + Snappy** and set FOCUS dataset version (`1.0r2`) in both `app/schedules.py::_body`
   and `infra/focus-exports.ps1`; keep `dataOverwriteBehavior = CreateNewReport`. Confirm the loader path (`app/exports.py`
   `_rows_from_parquet`) handles Snappy Parquet end-to-end with a fixture file.
2. **Bootstrap orchestrator** (new `app/bootstrap.py`, started from `lifespan` in `app/main.py`, guarded by a PG advisory lock so only
   one instance runs; feature flag `CLOUDLENS_MANAGED_EXPORTS=true`):
   - self-check capabilities (export write/run, storage role-assignment write) and surface missing roles with the exact fix command;
   - discover subscriptions visible to the app identity (ARM `GET /subscriptions`, follow `nextLink`);
   - for each subscription ensure exactly one CloudLens FOCUS export (daily MTD) exists (idempotent; reuse `owned()`);
   - queue runs in a PG table `export_jobs(subscription_id, month, status, attempts, next_attempt_at, last_error, run_started_at)`:
     current month first, then previous **12 months newest-first, round-robin across subscriptions** (changed 30 Sep, ADR-5:
     **previous 2 by default; the other 10 optional** from Setup); call `run_now()` with a
     1-calendar-month `timePeriod`; honour `429`/`Retry-After` with exponential backoff; cap concurrent runs;
   - on days 1–6 of each month re-queue the previous month (late adjustments); newly visible subscriptions auto-onboard.
3. **Setup page** (Admin/"Cost data" tab): progress grid months × subscriptions (queued / running / landed / loaded / failed), and the
   expectation text "first data usually within hours; brand-new exports can take up to 24 h".
4. Tests: mock ARM with httpx `MockTransport` — idempotent create, backfill ordering, 429 backoff, restart resumes from table.
**Done when:** on a fresh DB with mocked ARM the queue fills correctly and drains; on real Azure (S3 deployment) exports are created and
runs accepted (HTTP 200/202).

### S3 · Two-line Cloud Shell installer (H10–H13)
1. New `infra/install.ps1` (PowerShell 7, runs in Azure Cloud Shell): params `-Location` (required), `-Scope` (default current
   subscription; accepts `/providers/Microsoft.Management/managementGroups/<id>` or a subscription id), `-Size small|medium|large`
   (maps to `-PostgresSku` B2s-or-D2ds_v5 / D2ds_v5 / E4ds_v5 and storage), `-EntraClientId` (optional).
2. Steps: verify `az` login and pwsh 7 → register providers (`Microsoft.CostManagementExports`, `Microsoft.DBforPostgreSQL`,
   `Microsoft.Web`, `Microsoft.Storage`, `Microsoft.Network`, `Microsoft.ManagedIdentity`, `Microsoft.OperationalInsights`,
   `Microsoft.Insights`, `Microsoft.CognitiveServices` if AI kept) → `deploy.ps1` with mapped params and `-SkipFocusExports`
   (the app now creates exports) and `-EnableExportManagement` → role assignments on scope (Reader + Cost Management Contributor; at MG
   scope one assignment covers all subs) → set app setting `CLOUDLENS_MANAGED_EXPORTS=true` → wait for `/healthz` → print URL.
3. Cloud Shell compatibility: `tools/package.ps1` defaults `-Python python`; detect and pass `python3` when `python` is absent.
   Remove any Windows-only paths.
4. Distribution (decide with Ravi): **public GitHub release** (`install.ps1` downloads a release zip) **or** a zip handed to the
   customer and uploaded to Cloud Shell. For the sprint, run from a clone.
5. Test: fresh deploy to `rg-cloudlens-v3-test`; record wall-clock time; verify URL, sign-in, export creation (S2). Keep for S5, delete in S6.
**Done when:** two commands → working URL; rerun is idempotent; time recorded.

### S4 · Premium React UI foundation, day 1 (H13–H18)
Strangler: the new UI lives at **`/v2`** beside the classic UI at `/`, shares the same session cookie and `/api/*`, and takes over `/`
only when it reaches parity (switch-over rule, 8.4). Screens not yet migrated deep-link to the classic tab.
1. **Stack** (`ui/`, built into `web/v2/`, git-ignored, built by `tools/package.ps1`): React 19 + TypeScript (strict) + Vite;
   TanStack Router (typed URL search state: month, subscriptions, filters) · Query (cache, retries, 401 → `/login?next=/v2…`) ·
   Table + Virtual; ECharts via `echarts/core` (tree-shaken, lazy chunk); Tailwind v4 + Radix primitives in shadcn style; Framer Motion
   (route/panel transitions, `prefers-reduced-motion` respected); cmdk; self-hosted Inter/Geist with tabular numerals (CSP `font-src 'self'`).
2. **Server integration** (`app/main.py`): `/v2/assets/*` static (public, immutable hashed files), `/v2` and `/v2/{path}` SPA fallback
   behind `RequireAuth`; no inline scripts, so the existing CSP stays strict (`script-src 'self'`).
3. **App shell:** sidebar with 5 workspaces + Admin —
   - **Overview:** overview
   - **Explore:** billing, uptime ("Hourly Billing"), tags, resources, anomalies, history, ai-billing
   - **Optimize:** savings, commitments, performance
   - **Govern:** budgets, governance, esu, health (Retirements), changes, azure-updates
   - **Reports:** report (Export data)
   - **Admin:** settings (Cost data + new Setup progress), audit (admin only)
   Top bar: month picker, subscription scope, Refresh; theme dark/light/system; density; **Indian lakh/crore** number toggle; skeletons.
4. **⌘K / Ctrl+K palette (cmdk):** fuzzy over workspaces, screens, subscriptions and actions (Refresh, Theme, Density, Classic UI).
5. **Day-1 screens in React:** **Overview** (KPI tiles, daily trend, top services/subscriptions) and **Explore → Billing** (virtualised
   TanStack Table + chart). Remaining screens migrate slice by slice in the roadmap.
6. **Budgets:** initial JS < 200 KB gz (ECharts in its own chunk), LCP < 1.5 s locally.
7. **Tests:** Vitest (formatters, API client); pytest for `/v2` routing, auth gate and CSP; Playwright smoke (sign in → /v2 renders,
   ⌘K opens and navigates, theme persists); `npm run audit:a11y` extended to `/v2`. Screenshots into the session folder, not the repo.
**Done when:** `npm run build` clean, bundle budget met, tests pass, screenshots reviewed by Ravi.

### S5 · Spike: load inside the database with azure_storage (H18–H20)
On the **test deployment's** PostgreSQL only (never the Scale server):
1. Enable server params: `azure.extensions` += `AZURE_STORAGE,PG_CRON`; `shared_preload_libraries` += `azure_storage,pg_cron`;
   restart. Enable the server's **system-assigned managed identity**; grant it **Storage Blob Data Reader** on the storage account.
2. `CREATE EXTENSION azure_storage;` register the account with the managed-identity option
   (`azure_storage.account_add(azure_storage.account_options_managed_identity('<account>', 'blob'))` — **verify exact signature in the
   reference doc**), then `azure_storage.blob_list(...)` on the exports container.
3. Load one real FOCUS Parquet run via `blob_get(..., NULL::<typed row>, decoder := 'parquet')` into a table with **CTAS**; measure
   rows/s and memory vs the Python loader for the same run; check type fidelity (timestamps, decimals, JSON tags).
4. Write results as an ADR in section 12. **Switch the loader only if** it is correct and at least as fast; otherwise keep the Python
   byte-mover (transforms stay in SQL either way).

### S6 · Verify end to end and hand over (H20–H24)
1. Full pytest; `npm run test:browser`; re-bench → `tools/bench-tabs-v3-final.json`; compare with baseline in section 12.
2. Fresh install once more from the two-line command → exports created → backfill queued/running → dashboard renders (data may lag up
   to 24 h for new exports — record status).
3. **Delete `rg-cloudlens-v3-test`** (and any exports it created) unless Ravi asks to keep it.
4. Update section 12 (status, numbers, deferred items) and commit.

### Sprint acceptance scorecard (v3 preview vs v2)

| Check | v2 baseline | Target |
|---|---|---|
| Install steps | Windows + PowerShell 7 + Azure CLI + Python, `deploy.ps1` | **2 lines in Cloud Shell** |
| Exports + backfill | separate script, CSV | **automatic on first start, Parquet, 3 months (up to 13 optional)** |
| Slowest screen | 226 s | **< 1 s cold / < 300 ms warm** |
| Endpoints returning 400 | 3 | **0** |
| UI | 21 flat tabs, vanilla JS | **React app at `/v2`: 5 workspaces, dark mode, skeletons, ⌘K; Overview + Billing migrated** |
| In-DB loading | none | **spike result recorded (go/no-go)** |

### Explicitly NOT in the sprint (roadmap)
Migrating the remaining screens to React · `/v2` replacing `/` · separate web/worker identities · pg_cron pipeline as default · row-level security · "Reconciled with Azure" badge ·
partition per (month, subscription) with safe publish · collectors redesign · AI "Ask" redesign.

---

## 8. Roadmap after the sprint — full v3 (≈ 12 weeks to pilot MVP, 1 dev + AI)

### 8.1 Database design (all processing in PostgreSQL)
- Schemas: `raw` (unlogged staging) · `core` (facts + dims) · `mart` (screen summaries) · `app` (users, settings, jobs, export_runs,
  audit) · `api` (the only surface the web app may call).
- Dims with integer keys: subscription, resource_group, resource, service, region, meter, **tagset** (deduped tag JSON), tag.
- `core.cost_line`: `RANGE(month)` → `LIST(sub_key)`; each leaf = one export unit (subscription-month).
- Marts: `cost_daily` (day × sub × RG × service × region × charge/pricing category × commitment type × currency) · `cost_tag_daily`
  (configured tag keys only) · `cost_resource_month` · `usage_month` (hours `smallint[31]`) · `anomaly` (rolling median/MAD) ·
  `forecast` (run-rate regression) · `savings` (list/contracted/effective; *observed* commitment coverage) · `variance`.
- Pipeline: `pg_cron` `cl.discover()` every 5 min (paged `blob_list`, runs keyed by subscription, month, runId, manifest ETag) → N
  distinct loader jobs (pg_cron never overlaps a job with itself) each **leasing** one unit (`SKIP LOCKED`, lease expiry, retries,
  dead-letter), one transaction, no internal COMMIT: stage via `blob_get(parquet)` → upsert dims → CTAS normalised leaf → add NOT NULL
  + CHECK(month, sub) + matching indexes → ANALYZE → build mart rows in staging.
- **Safe publish** (short txn, `lock_timeout` + retry, only if the run is newer than the active revision): DETACH old leaf, ATTACH new
  (no validation scan, no index build), replace mart rows for (sub, month), bump per-(sub, dataset) version, NOTIFY; drop old leaf async.
- Retention via `pg_partman` (default 13 months). Support envelope v1: ≤ 250 subscriptions/instance; planner tested at 5,000 leaves.
- Security: roles `cl_owner` / `cl_pipeline` / `cl_api`; **FORCE ROW LEVEL SECURITY**; scope via `SET LOCAL` per transaction.
- Correctness: keyset pagination + truncation flags; follow every continuation token; never sum across currencies without an FX
  policy; perf gates via `EXPLAIN (ANALYZE, BUFFERS)`.

### 8.2 Identities, network, deployment
- **id-web** (App Service): `cl_api` DB role only. **id-worker** (Container Apps Job, not internet-facing): Reader + Cost Management
  Contributor on scope, Storage Blob Data Contributor, ABAC-limited UAA on storage, PG Entra admin (migrations).
  **PG server MI:** Storage Blob Data Reader.
- Easy Auth: auth-code flow with the web UAMI as **federated credential** (no client secret, no implicit grant). MVP authorisation =
  in-app allowlist seeded with the installer (no Entra P1 group dependency).
- Network: VNet (snet-app, snet-jobs, snet-pg, snet-pe), private DNS; storage `publicNetworkAccess=Enabled`, `defaultAction=Deny`,
  bypass AzureServices, blob private endpoint; startup probe = PG `blob_get` of a canary blob + export test write, with RBAC-propagation
  retries.
- Installer preflight uses `az deployment sub validate` to surface Azure Policy denies; `--uninstall`; idempotent rerun = upgrade;
  Entra mode (b) = admin runs `entra-setup.ps1` and passes `-EntraClientId`.

### 8.3 App and UI
- API: FastAPI + psycopg3 pool (Entra token); ~12 endpoints; cache keyed by per-(sub, dataset) versions + ETag/304; OpenAPI → TS client.
- UI: React 19 + TypeScript + Vite; TanStack Router (typed URL state) / Query / Table + Virtual; ECharts (lazy); Tailwind v4 +
  Radix/shadcn; Framer Motion; cmdk; Geist/Inter tabular numerals; dark/light; density; WCAG 2.2 AA; lakh/crore.
- IA: Overview · Explore (one explorer: group by any dims, cross-filter, drill breadcrumbs, compare periods, resource drawer with cost
  trend + uptime heatmap + tags + inventory) · Optimize · Govern · Reports · Admin (+ optional Ask).
- Budgets: initial JS < 200 KB gz · LCP < 1.5 s · API p95 < 300 ms · cached interactions < 100 ms.

### 8.4 Phases and gates

| Weeks | Phase | Gate |
|---|---|---|
| 1–2 | Spikes (before UI): Easy Auth + UAMI FIC; network (exports to firewalled storage + PG `blob_get` via PE); `azure_storage` parquet on real FOCUS; 5.6M-row month load + publish on real disks for B2s / D2ds_v5 / E4ds_v5; overwrite-off manifest behaviour; UI prototype | ADR with numbers, go/no-go |
| 3–4 | Installer + infra (Bicep, install/uninstall, entra-setup) | 2 lines → URL < 20 min on a clean sub; idempotent |
| 4–6 | DB core + pipeline + RLS + api schema + DB tests | idempotent reload; out-of-order runs never regress; reconciliation exact |
| 6–7 | Worker: orchestrator, reconciliation, setup/health UI | clean deploy → first dashboard, zero manual steps |
| 7–10 | API + remaining React screens (foundation shipped in sprint S4) + Explore + Excel export; `/v2` becomes `/` | Lighthouse ≥ 90, p95 < 300 ms, Playwright |
| 11–12 | Hardening + pilot: 20M rows/mo × 13 scale test, security pack, docs | pilot customer live |
| +8 | v1.1: collectors (ARG, Advisor, policy, retirements, changes, metrics), Optimize, Govern, PowerPoint/scheduled reports, saved views, SSE, group access, private-UI, Ask CloudLens | per-workspace parity + perf |

**Switch-over rule:** v3 replaces v2 only when (1) totals match Azure and v2 on the same estate, (2) every screen beats v2's measured
time, (3) clean install < 20 min, (4) it covers every tab the pilot customer uses. Until then v2 stays the demo/production app.

## 9. Sizing and cost per customer (compute verified; storage/network estimated)

| Tier | Rows/month | PostgreSQL | App | ≈ $/month |
|---|---|---|---|---|
| Small | < 1M | B2s (only if spike proves backfill on its real disk; else D2ds_v5) | B1 | 110–130 |
| Medium | 1–5M | D2ds_v5 + Premium SSD v2 3,000 IOPS | B2 | 240–260 |
| Large | 5–20M (e.g. 5.6M) | E4ds_v5 + Premium SSD v2 | B2 / P0v3 | 480–520 |
Every tier: defined minimum IOPS (never P4), 2.5× largest-month temp headroom, backfill concurrency per tier; option to bootstrap on a
larger SKU and downsize after backfill.

## 10. Risks and mitigations
- `azure_storage` parquet limits → keep Python byte-mover; transforms stay SQL.
- Cost Management throttling with many subscriptions → queue, backoff, newest-first.
- New exports take up to 24 h → progress UI + clear expectation.
- Customer Azure Policy denies → `validate` preflight; private-mode / ACR options.
- Entra app registration blocked → `-EntraClientId` mode.
- Subscription-scope blind spots → documented; optional billing add-on.
- Burstable CPU credits during backfill → tier floor decided by spike.
- Row-store ad-hoc limits → marts + drill-down design.
- Partition count → support envelope.

## 11. Open decisions for Ravi
1. Default retention 13 months?
2. Distribution: public GitHub release vs zip handed to customer (and container image: ghcr.io vs customer ACR)?
3. UI public-with-Entra (default) vs private-only?
4. Keep Foundry/AI in the default install or make it opt-in (`-EnableAi`)?
5. Pilot customer?

---

## 12. Status tracker (update as you go)

| Task | Status | Started | Finished | Result / notes |
|---|---|---|---|---|
| S0 Freeze & branch | ☑ done | 30 Sep 00:50 | 30 Sep 01:30 | Clone at `D:\cloud lens v3`, branch `v3`. Baseline pytest **2169 passed / 13 failed / 10 skipped** (26 min); the 13 re-fail identically with no v3 changes (pre-existing, listed below). Tab bench baseline still to capture. |
| S1 Speed fixes | ◐ partial | 30 Sep 05:20 | | Bench `tools/bench-tabs-v3-baseline.json` → `bench-tabs-v3-s1.json` (cold / warm). **Executive 91.7 s → 1.2 s cold** (new stamped `resource_counts` serving table, exact; ORDER BY hint removed: scoped path 95 → 14.5 s). **Tags 77 → 28 s** and **Insights 79 → 31 s cold, 77 → 0.02 s warm** (daily tag cells no longer built only to be dropped). The three "400s" were input validation (scope required), not failures: bench now passes a scope; change-analysis/performance then return a structured 502 because the demo subscriptions are not readable by the local identity — honest, left as is. **Open:** Resources 110 s (builds per-service detail for ~2M resources to publish 8,000; a rank-first rewrite measured *slower*, 227 s — needs the planned server-side pagination + serving table); waste 23 s (per-row `lower(trim(ResourceId))` ≈ 7 µs under the Windows locale; needs a normalised, indexed resource key in `resource_presence`); cold-only live-Azure tabs 15–43 s (warm 0.01 s via the persistent per-user snapshot cache; v3 UI should prefetch); anomalies 1.9 s (never cached by design while coverage is `partial`). **Resources done (30 Sep, ADR-2):** 107.6 s → **one page in 0.42–0.89 s cold, 0.02–0.05 s warm** for every UI period (7/30/60/90 d, recent months), sort (cost/prior/delta), change and currency filter, any scope (one sub 0.77 s, all 70 subs 2.5 s cold); page 20,000 0.60 s. New `app/resource_ranks.py` (integer keys + per-period rankings, rebuilt after each derived rebuild, stamped) + paged `/api/dashboard/resources` + `/v2/explore/resources`. Exactness: every page together == the original query on a fixture (all windows, months, scopes, filters, sorts); on real data the 30-day ranking matched the old aggregation on 2,032,675/2,032,675 resources, 0 money mismatches. Build 305–430 s, ≈3 GB. Remaining: on-the-fly windows (not offered by the UI, e.g. 14 d) 13.8 s cold; filter bar (rg/region/…) 36–57 s cold; search for a term matching ~all resources ~6 s (specific terms 0.3–1.8 s); all 0.02–0.04 s warm. Classic tab (no `page`) 7–11 s, down from 108 s but still a 14.6 MB body over the 8 MB snapshot-cache cap — move the classic tab to paging or retire it for `/v2`. **Waste done (30 Sep):** its warehouse pricing (`waste._costs_for`, also behind rightsizing/recommendations/hybrid/what-if) 24.8 s → **0.04 s** by looking ids up in `resource_ids` (hash index, 64 MB) → `resource_daily(rkey, day)`, falling back to the presence query when rankings are stale; identical on real data. Waste cold time is now only live Resource Graph (16 queries, ~16–27 s, apparently concurrency-capped). **Tags done (1 Oct):** the tab's 34 s was one query, ranking ~2M resources to publish the top 8,000 (20 s, then the name join). `tags._ranked_candidates` now reads the top ~9,000 from the stored `resource_ranks` (0.07 s) and Tags' own aggregation runs over only those ids, so every figure is computed as before; the rankings choose *which* resources. Used only for a stored rolling window (7/30/60/90 d), an unconverted, unfiltered reader and a current ranking; otherwise, and on any error, the original query runs. Accepted only if the 8,001st cost is strictly above the lowest candidate cost (a proof nothing outside could have ranked in). **44 s → 10.9 s cold end to end (in-process 35–42 s → 4.6 s), 0.3 s warm**; target <1 s not met: the restricted aggregation is ~3.7 s (0.8 s of it the whitespace-only-id branch, kept for exactness). Same payload as the original on the real estate: same 8,000 resources, tags, keys and totals; per-resource cost differs by ≤ 6e-9 (BilledCost is double precision; the original differs from itself by 4e-9 between two runs). Residual, documented: a raw spelling of one resource with a *negative* cost could in theory sit outside the candidates; none exist in the data. `tests/test_tags_ranked.py` 18 ✓ (incl. spellings that merge, no-id rows, whitespace id, two currencies, scopes, a cap that forces the proof, month/stale/converted fallbacks); Tags + ranks + uptime + snapshot suites 252 ✓. **Empty states done (1 Oct):** `change-analysis` and `performance` no longer return 502 when the identity cannot see the selected subscriptions. Azure answers 400 `NoValidSubscriptionsInQueryRequest` (or 403); only that is recognised (`service_health.ScopeNotVisible`, raised in `_arg_page`) and returned as **200** `{status: "unavailable", available: false, reason, …}` with the full envelope (window, generated_at, empty list), so the classic screen shows its banner and the reason. Never an empty success. Timeouts, throttling (429), 5xx, invalid JSON and every other 4xx stay **502** (`test_failures_are_unavailable_not_empty_success` unchanged and passing). 4 new tests (envelope, boundaries, classification via a mock transport); neighbouring suites 186 ✓; checked live and in the browser. `service-health` already returned 200 with an error envelope. |
| S2 First-run exports in app | ☑ done — **verified live 30 Sep 20:44** | 30 Sep 17:05 | 30 Sep 20:45 | **Live backfill measured (30 Sep, 13-month code `19e1a39`): fresh install → all 13 months loaded, unattended, 0 throttles, 0 failures: 37,242 FOCUS rows (2.97 MB Snappy Parquet, 1 file per month).** Wall-clock **3 h 32 min** from the export's first run (20:14:47 IST; brand-new export, delivered ≤ 27 min) to 13/13 loaded (23:46:47); the 12 earlier months ran one after another (one Azure run per subscription at a time) in 3 h 04 min — **12.5–21.1 min per month (median 14.2, mean 15.4)**. The app's own import work was **90 s in total** (5–20 s per month end to end), so wall-clock is Azure report generation, not loading. At the new 3-month default the same install is complete in ≈ 1 h. **Default changed 30 Sep 22:40 (Ravi, ADR-5): the first run imports 3 months; earlier months, up to 13, are optional from Setup** (`/v2/admin/setup` History control → `POST /api/cost-data/history`; one earlier-history job per window, after each subscription's current job; recorded as `extended_from`). Tests: `test_managed_exports.py` 14 ✓ (incl. optional history end to end, and the admin-only bounded route), S2 neighbours 218 ✓, installer/deploy/`/v2` 10 ✓, `npm run test:v2` 21/21, axe clean on Setup with the control (light + dark). The live test RG still runs the 13-month code (`19e1a39`), so its backfill measures the full optional horizon. **Live (rg-cloudlens-v3-test):** unattended, the app adopted the operator-created export, ran September as a month window, and imported **6,088 FOCUS rows from Snappy Parquet** (manifest-exact, 632 KB); August generating, 11 months queued newest-first. Design corrected by the live test (ADR-4): the app's identity may *run* but not *create/update* an export, so the installer creates it (paused) and the app adopts it; a refused create now names the exact operator command and setup resumes by itself. See ADR-3 for the pipeline reuse. Offline build detail — see ADR-3: no new `export_jobs` table — the existing durable Cost-data pipeline (`cost_data` → one `focus-setup` job → `focus_workflow.step`, PG `meta` + advisory lock + lease, `recover()` after restart) already did create/run/poll/import/retry; S2 adds the unattended driver and the missing pieces. (1) Exports now **Parquet + Snappy, FOCUS `1.0r2`** in `schedules._body` and `infra/focus-exports.ps1` (enum spellings verified against the 2025-03-01 spec). Loader: Azure partitions are < 1 GB uncompressed, but the loader refused any file > 64 MB and any Parquet file decoding to > 64 MB in total — real partitions would have failed; now Parquet download ≤ `EXPORT_MAX_PARQUET_BYTES` (1 GiB) and the 64 MB bound applies per decoded batch (memory actually held); timestamps spelled ISO like CSV. Snappy 1.0r2 fixture (manifest + 2 partitions, timestamp and string dates) loads through the real `ingest_export`. (2) `app/bootstrap.py`: `CLOUDLENS_MANAGED_EXPORTS=true` → hourly pass under a lease: paged `GET /subscriptions` (**`cost.list_subscriptions` never followed `nextLink`** — fixed for every caller), capability self-check with exact `az role assignment create …` fix commands (per subscription: Cost Management Contributor; deployment: ABAC-limited UAA on storage), then one managed `focus-setup` job for every unmanaged subscription with a **13-month horizon** (current + 12 whole months; interactive stays ≤ 365 days). `focus_workflow.step`: newest month first, round-robin across subscriptions; deployment-wide cap `CLOUDLENS_EXPORT_CONCURRENCY` (8) in `claim_run` (self-heals leaked reservations); 429/503 → `max(Retry-After, 60·2ⁿ⁻¹ s, ≤ 1 h)` and **no new run anywhere** until the backoff passes (Cost Management throttles per tenant); unchanged task saves skipped (a 70-sub backfill is one ~1,000-task job). Late adjustments: existing daily tick + 90-day reconcile on the 7th (replaces "re-queue days 1–6"). (3) `GET /api/cost-data/progress` (DB only, 0.04 s live) + `POST /api/cost-data/bootstrap` (admin "Check now"); React **Admin → Setup progress** `/v2/admin/setup`: months × subscriptions grid (queued / generating / importing / loaded / failed), blockers with copyable fix commands, 24-h expectation. (4) Tests: `test_managed_exports.py` (stateful fake ARM via `httpx.MockTransport`: nextLink + hostile link, idempotent create, Parquet body, cap + round-robin order, 429 backoff + queue hold, restart resumes without resubmitting, new subscription onboarded, flag/read-only off, grid, routes), `test_parquet_exports.py`; `npm run test:v2` 21/21 incl. axe on Setup. Not done here: a live Azure run (needs S3's test RG and Ravi's OK). |
| S3 Two-line installer | ☑ done (live) | 30 Sep 18:25 | 30 Sep 20:45 | **Live installs into `rg-cloudlens-v3-test` (Central India, small, `-LocalSignIn`) from a clean worktree:** run 1 **18 min 27 s** to a working stack, but exited on a publish `504` while the B1 build (8 min) went on to succeed, and its log-printed password was unreachable (no console log) → fixed (`a4459bd`): publish follows the Kudu record to status 4/3; the installer makes the admin password locally and deploys only its PBKDF2 hash. Run 2 (rerun) **12 min 38 s**, exit 0: every role `already-present`, storage/app/DB reused, 504 followed to "succeeded", sign-in verified. Run 3 **15 min 47 s**, exit 0, with the operator-export step (`19e1a39`): existing export updated in place with its eTag, admin kept. New `infra/install.ps1` (pwsh 7 / Cloud Shell): checks → `-Scope` (subscription, or management group with every descendant subscription via paged `…/descendants`) → registers missing hosting providers + `Microsoft.CostManagement(Exports)` in every monitored subscription → `deploy.ps1` with `-Size` profile (small D2ds_v5/64 GB/B1, medium D2ds_v5/128 GB/B2, large E4ds_v5/256 GB/B2), managed exports on → creates the paused exports as the operator → URL + `/v2/admin/setup`; `-LocalSignIn [-ResetLocalPassword]`, `-EntraClientId`, `-WhatIf`, `-Source <zip>` (distribution still open). Supporting: Bicep `managedExports`; `-CostScopeManagementGroup`; Cloud Shell path/python fixes; 5-min bootstrap recheck while blocked. Tests: `tests/test_install.py` (18, fake `az`, parameter contracts pinned to both real scripts), MG cost-access, deploy follow-through, operator-adoption end to end. |
| S4 React UI foundation | ◐ foundation done | 30 Sep 01:00 | 30 Sep 02:05 | `ui/` → `web/v2`, served at `/v2` (`app/web_v2.py`). Shell (5 workspaces + Admin), ⌘K (cmdk), month/scope in URL, theme/density/lakh-crore, skeletons, Motion. **Overview** + **Billing** (virtualised TanStack Table) on live API; **All resources** added 30 Sep (server-paged/sorted, search, change + currency filters; `DataTable` gained a controlled server-sort mode; `npm run test:v2` 18/18 incl. axe on Resources); **1 Oct: the rest of Explore** — Anomalies, Cost by Application / Tags, Hourly Billing (Uptime), History — on the existing `/api` (no server changes; initial JS **175 KB gz**, each screen a lazy chunk of 2–3 KB; `npm run test:v2` **36/36** incl. axe on all four; History's populated comparison is covered with mocked archive endpoints because no archive is configured locally, Anomalies was only seen empty on the demo estate; `DataTable` scroll area takes keyboard focus when no header sorts); Tags and Uptime payloads are heavy (7.8 MB / 26–44 s first call locally, filtered in the browser as classic does) and are cached 5 min client-side; other 13 screens hand off to classic via `/?tab=`. Initial JS **177 KB gz** (budget 200). Tests: `tests/test_web_v2.py` 8 ✓, Vitest 9 ✓, `npm run test:v2` **14/14** (incl. axe WCAG 2.2 AA light+dark, no CSP errors). Packaging builds UI when npm exists. Full suite after S4: **2178 passed / 12 failed / 10 skipped** — every failure is in the baseline list, none new. Remaining: Ravi review of screenshots; migrate further screens. |
| S5 In-DB load spike | ☑ done — **no-go** (ADR-6) | 30 Sep 23:40 | 1 Oct 14:09 | On the D2ds_v5 copy `cloudlens-pg-5f6eh-r1` (the original server is stuck; handover 1 Oct §3). 5.8M-row synthetic month: in-DB 456 s / 284 s / 257 s at 1 / 3 / 6 sessions vs Python 938 s (2.1–3.7×), **but `azure_storage` 1.10 drops the sign of decimals in (−1, 0): 319,818 rows wrong, BilledCost +0.35%**; the 13 real months (37,242 rows) identical both ways and equal to `costs`. Python byte-mover stays. Harness `…\Microsoft Scout\cloud-lens-v3-s5`. |
| S6 Verify & hand over | ☐ not started | | | |

**Baseline tests:** 2169 passed / 13 failed / 10 skipped (pre-existing failures: test_datastore_safety::…unknown_plus_usd…,
test_environment_rollup, test_focus_day_repair ×3, test_focus_incremental::…changed_nothing…, test_overview,
test_postgres ×2, test_read_only_mode::…caches_but_no_ingest_workers, test_savings_frontend::…theme_contrast,
test_summary_pending, test_visuals) · **After S2:** 2263 passed / 13 failed (same set; test_budget_reading replaces
theme_contrast since S1) / 10 skipped · **After S3 code (`4f57bfc`):** 2266 / 13 (same set) / 10 · **After S2+S3 live
fixes:** 2268 / 13 (same set) / 10 · **Final tests:** _ ·
**Install wall-clock:** 12 min 38 s rerun, 15 min 47 s with operator exports; first run 18 min 27 s to a working stack
(+ manual follow of the build, since fixed) · **Backfill wall-clock (13 months, 1 subscription):** 3 h 32 min from the
first export run to 13/13 loaded, 37,242 rows; import work 90 s of it · **Test RG deleted:** _

### ADR notes
- **ADR-1 (30 Sep) React from day 1, strangler at /v2.** Versions pinned by lockfile: React 19.3, Vite 8.3 (Rolldown),
  TypeScript 7.0, TanStack Router 1.170 / Query 5.103 / Table **9.2** (v9 API: `useTable` + `tableFeatures`, not
  `useReactTable`) / Virtual 3.14, ECharts 6.1 (`echarts/core`, lazy chunk ≈ 188 KB gz), Tailwind 4.3, `radix-ui` 1.6,
  Motion 13 (`LazyMotion` + `domMax` loaded after first paint), cmdk 1.1, Inter Variable self-hosted. Theme is set
  pre-paint by an external `/v2/theme.js`, so CSP stays `script-src 'self'`. Build output is git-ignored and produced by
  `tools/package.ps1` when npm exists (a missing npm warns, not fails — classic UI remains the product until parity).
- **ADR-2 (30 Sep) Resources: rank integers once, compute only the page.** Measured on the 16.9M-row estate: the
  old query spent ~90 of 108 s sorting 2M long text ids under the `English_India.1252` libc collation (3 GB of
  external merges). Probes: `COLLATE "C"` on the old query broke the `resource_tags` index (abandoned); integer keys
  alone gave 6.4 s (30 d) — still one single-threaded 2M-group hash per request; a stored ranking per period gave
  0.02 s to rank + 0.25 s for exact page details. So `resource_ranks` builds, from published `resource_presence`,
  `resource_subs`/`resource_ids`/`resource_raw` (identity → int), `resource_daily` (int fact),
  `resource_rank_periods` (keyed by exact `(lo, mid, hi)` bounds — a request is served only when its own bounds
  match), `resource_ranks` (period, rnk, rkey, skey, currency, cost, prior, change) and `resource_rank_totals`
  (per period × sub × currency × change). Not a DERIVED_MODULE (a rank depends on every resource, so it cannot be
  repaired per month): full CTAS rebuild in `refresh_serving`, stamp `resource_ranks_generation`, withdrawn by
  `coherent_rollup`; until current, the tab uses the original capped query (`source: legacy`). Page details are the
  original SQL restricted to the page's raw ids, so every figure is computed exactly as before. Periods ranked:
  7/30/60/90 d + newest `CLOUDLENS_RESOURCE_RANK_MONTHS` (3) months, deduplicated by bounds. Everything else ranks on
  the fly from `resource_daily` (scope pushed down) or, under the filter bar / currency conversion, from the
  reader's own rows joined to `resource_raw`.
- **ADR-3 (30 Sep) S2 drives the existing Cost-data pipeline instead of adding `export_jobs`.** v2 already had a
  durable, approval-gated FOCUS pipeline: `cost_data.preview/create` → one `focus-setup` job (per subscription a
  `configure` task that creates the owned export, grants its MI the container and pauses native recurrence, plus one
  task per calendar month); `focus_workflow.step` keeps one outstanding Azure run per subscription with a persisted
  submission intent (no blind resubmit after a crash), polls manifests and imports exactly that run; jobs live in PG
  `meta` under an advisory lock and a deployment-wide lease; `recover()` resumes after restart; `cost_data.tick` keeps
  subscriptions current. A parallel `export_jobs` queue would have duplicated all of it. So `app/bootstrap.py` is the
  unattended approver (flag set by the installer = the administrator's approval) and S2's requirements became
  targeted changes to that pipeline: Parquet/Snappy/1.0r2, managed history horizon (13 months at first; 3 by
  default since ADR-5), newest-first round-robin,
  a deployment-wide concurrency cap, tenant-wide throttle hold with exponential backoff, and `nextLink` paging.
  Native export recurrence stays paused as before: the app runs exact month windows itself (validated, idempotent),
  so the app must be running for daily updates — true for App Service.
- **ADR-4 (30 Sep) The operator creates each export once; the app only runs it.** The first live install showed
  Cost Management refusing the app's managed identity every export `PUT` (`401 RBACAccessDenied`), with the designed
  ABAC-limited UAA and then — as a reversible experiment, removed afterwards — an unconditional RBAC Administrator on
  the storage account held 14 min (past the ~10 min propagation v2 recorded). The same identity's `POST …/run` on an
  operator-created export returned 200 and imported September (6,088 rows). So: `install.ps1` creates one **paused**
  owned export per monitored subscription as the operator (`focus-exports.ps1 -Paused`, eTag-safe on rerun); managed
  `configure` adopts it without writing (a native schedule it cannot pause is left active and recorded; its runs are
  never imported); if it must create and is refused it names the exact operator command, which bootstrap shows as a
  blocker and retries every 5 min until setup continues by itself. R4 still holds — plain RBAC, no EA/billing roles —
  the only extra step is at install time (and per subscription added later), done by the person already installing.
  The ABAC-limited UAA on storage is now unused by the app; kept until S6 confirms nothing else relies on it.
- **ADR-5 (30 Sep) History: 3 months by default, earlier months optional (Ravi).** The first run imports the current
  month and the two before it (`cost_data.DEFAULT_HISTORY_MONTHS`): every 30- and 60-day view is complete, and a
  subscription is loaded after 3 export runs instead of 13 (live: ≈ 28 min for a brand-new export's first month, then
  ≈ 14 min per month, one run per subscription at a time). An administrator adds earlier months on **Setup**
  (`/v2/admin/setup`, 3 · 6 · 12 · 13; `POST /api/cost-data/history`), stored as `bootstrap:history_months`. Each
  bootstrap pass then queues, per configured subscription whose current job has finished, only the months before
  everything already requested — one more `focus-setup` job (payload `action: "history"`, no configure task,
  existing reports reused) shared by every subscription with the same window. It is recorded as
  `extended_from` on the subscription's config **in the same transaction as the job**, so it is asked for once even
  after the job leaves recent listings; `history` (the daily catch-up anchor) is deliberately untouched, else one
  unsupported historical month would make every daily update re-import the whole setup window. The grid shows every
  month requested for any listed subscription (never beyond 13) and merges tasks across a subscription's jobs.
  Subscriptions set up after the choice get the whole horizon in their first job. Known limit: a subscription's
  daily update waits while its earlier-history job runs (existing one-job-per-subscription rule; R8 allows 24 h).
- **ADR-6 (1 Oct) [accepted by Ravi, 1 Oct 16:07] Keep the Python loader: `azure_storage` 1.10 drops the sign of decimals between −1 and 0.**
  Spike on the test deployment's PostgreSQL (D2ds_v5; a point-in-time copy, because the original was stuck),
  harness outside the repo (`…\Microsoft Scout\cloud-lens-v3-s5`): container instances in the VNet as
  `id-cloudlens`; the Python side is the app's own `ingest_export` path; the SQL side is
  `blob_get(…, NULL::<row type built from the file's footer>, decoder := 'parquet')` through the same header mapping
  into the staging-table shape. Speed on a 5.8M-row synthetic month: Python 938 s (6,180 rows/s); in-database
  456 s with one session, 284 s with three, 257 s with six (2 vCores saturate) — 2.1–3.7× faster. Correctness: the
  13 real months (37,242 rows) were identical both ways and equal to `costs`; the synthetic month was not — 319,818
  rows differed in all six money columns. Measured on the decoder alone, every Parquet `decimal128(38,18)` value in
  (−1, 0) arrives without its minus sign, whatever the declared type (`numeric`, `text`, `double precision`, `bytea`
  all receive the text `0.63279…`), so there is no SQL-side workaround; the month's BilledCost came out +0.35%. The
  real exports had no such values, which is why they matched, but a small credit or rounding adjustment would become
  a charge. Per §7 S5 the loader switches only if correct, so the Python byte-mover stays and transforms stay in SQL;
  re-check with `spike.py decimals 1` when `azure_storage` changes. Also learned: the decoder binds by column position
  only; a null text cell is blank to Python and must be in SQL too; a restored server has no managed identity until
  re-enabled (`azure_storage` then reports "insufficient arguments provided to blob fetching process"); on 8 GB an
  all-column `GROUP BY` with `work_mem = 1GB` and parallel workers ran the server out of memory, and crash recovery
  emptied the unlogged tables.
