# CloudLens v3 interface (`ui/`)

React 19 + TypeScript + Vite, with TanStack Router/Query/Table/Virtual, ECharts (lazy chunk), Tailwind v4 + Radix
primitives, Motion and cmdk (⌘K / Ctrl+K). Served by the FastAPI app at **`/v2`** beside the classic interface at `/`,
using the same sign-in, the same `/api/*` and the same Content-Security-Policy (the build has no inline script).

| Command | What it does |
|---|---|
| `npm ci` | Install exact dependencies |
| `npm run dev` | Dev server on http://localhost:5173/v2/, proxying `/api`, `/login`, `/auth` and `/assets` to `CLOUDLENS_BACKEND` (default http://localhost:8100). Use `localhost` for both so the session cookie is shared. |
| `npm run build` | Type-check, then build into `../web/v2` (git-ignored; `tools/package.ps1` runs this when npm is available) |
| `npm test` | Vitest unit tests |

From the repository root, `npm run test:v2` runs the Playwright smoke (sign-in, Overview, ⌘K, Billing table, theme, CSP,
axe WCAG 2.2 AA) against `CLOUDLENS_URL` with `CLOUDLENS_USER` / `CLOUDLENS_PASSWORD`.

**Layout:** `src/nav.ts` is the single list of workspaces and screens (sidebar, palette and hand-off pages all read it).
Screens not yet rebuilt route to `/v2/classic/<tab>`, which opens the classic interface at `/?tab=<tab>`. Global view
state (`month`, `scope`) lives in the URL. Colours are CSS variables in `src/styles.css`; the light theme's text tokens
are chosen for ≥ 4.5:1 contrast. Budget: initial JS < 200 KB gzip (ECharts, the table and the animation engine load
later).
