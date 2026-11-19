# CloudLens v3 interface (`ui/`)

React 19 + TypeScript + Vite, with TanStack Router/Query/Table/Virtual, ECharts (lazy chunk), Tailwind v4 + Radix
primitives, Motion and cmdk (⌘K / Ctrl+K). Served by the FastAPI app at **`/v2`** beside the classic interface at `/`,
using the same sign-in, the same `/api/*` and the same Content-Security-Policy (the build has no inline script).

| Command | What it does |
|---|---|
| `npm ci` | Install exact dependencies |
| `npm run dev` | Dev server on http://localhost:5173/v2/, proxying `/api`, `/login`, `/auth` and `/assets` to `CLOUDLENS_BACKEND` (default http://localhost:8100). Use `localhost` for both so the session cookie is shared. |
| `npm run build` | Type-check, then build into `../web/v2` (git-ignored; `tools/package.ps1` runs this when npm is available) |
| `npm test` | Vitest unit and mocked-browser regression tests |

From the repository root, `npm run test:v2` runs the Playwright smoke (sign-in, Overview, ⌘K, Billing table, theme, CSP,
axe WCAG 2.2 AA) against `CLOUDLENS_URL` with `CLOUDLENS_USER` / `CLOUDLENS_PASSWORD`.

**Layout:** `src/nav.ts` is the single list of workspaces and screens (sidebar, palette and hand-off pages all read it).
Bookmarked `/v2/classic/<tab>` hand-offs redirect to their native routes. Global view
state (`month`, custom `from`/`to`, rolling `days`, `scope`, and display `currency`) lives in the URL.
The sidebar logo links to Overview and preserves those filters, even when the sidebar is collapsed.
The sidebar uses compact direct links with space between workspace groups on tall windows. On short windows it switches to workspace and page selectors so navigation does not require scrolling the rail.
Analyst findings use the display currency; chat sends the selected dates/window but returns native billing currencies,
explicitly disclosing that display FX is not applied. Per-answer server context is shown with streamed answers.
A failed initial analysis waits for an explicit retry.
Billing remains a calendar-month statement in native currencies; Advisor Score is live subscription-scoped evidence.
Anomalies includes every date in the reporting period, keeps missing amounts as gaps, and opens top cost
contributors when a date is selected. History compares any two usage dates with side-by-side bars, a per-currency table, and separate
top contributor rankings for each date. A shared control groups both rankings by service, subscription, or resource group.
Archive restatements are separate and still require two dated snapshots of the same dataset.
Savings source windows are independent of historical reporting periods. Cost sorting groups matching native-currency
buckets and compares their numeric amounts, without adding or converting different currencies.
Schedule simulations live under **Explore → Hourly Billing**. **Governance → Accelerated Networking candidates**
lists attached NICs with the feature off and Azure-confirmed VM-size support; remediation is done in Azure.
The Overview places spend first with a compact Advisor Score strip below it. The standalone End of support
tab has been removed; lifecycle evidence remains in **Commitments → Hybrid Benefit & support**.
Native browser suites use independent Vite caches to avoid optimizer invalidation/file-lock races between fixtures.
They close contexts after every test, including failed tests, and close dev-server connections before shutdown.
Colours are CSS variables in `src/styles.css`; the light theme's text tokens
are chosen for ≥ 4.5:1 contrast. Budget: initial JS < 200 KB gzip (ECharts, the table and the animation engine load
later).
