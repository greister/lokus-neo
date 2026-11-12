# Fork Notes — `greister/lokus-neo`

## Provenance

| | |
|---|---|
| Upstream | [lokus-ai/lokus](https://github.com/lokus-ai/lokus) |
| Base commit | [`dea4909dc536854cf59e378895e52fd3b9f015b9`](https://github.com/lokus-ai/lokus/commit/dea4909dc536854cf59e378895e52fd3b9f015b9) — 2026-08-27, `Merge pull request #555` |
| Base version | 1.3.0 (`package.json`) |
| License | **FCL-1.0-MIT** — upstream `LICENSE` retained unchanged. Converts to MIT two years after each release. Free for personal / educational / research use; commercial use as a competing product requires a separate licence. |
| Status | Personal fork for local use. Not affiliated with, endorsed by, or supported by the Lokus team. |

This fork is **not** an official Lokus release. Do not file bugs against upstream
for behaviour described below.

## What changed

### 1. In-app HTML report preview (main feature)

Local `.html` / `.htm` files open as a rendered web page instead of raw
ProseMirror text.

- `src/components/HtmlViewer/HtmlViewerTab.jsx` + `HtmlViewerTab.test.jsx` — new
  viewer tab with a `预览 / 源码` toggle persisted in `localStorage`.
- `src/utils/htmlUtils.js` — `isHtmlFile()`, preview toggle, and
  `prepareHtmlForPreview()`.
- `src/components/EditorGroup.jsx` — route `.html` / `.htm` tabs to the viewer.

Two non-obvious problems are handled:

- **Reading the file.** The viewer uses the app's own `read_file_content` IPC
  (the same channel the markdown editor uses), *not*
  `@tauri-apps/plugin-fs`. The fs plugin's ACL/scope does not cover arbitrary
  workspace paths, so `readTextFile()` fails with
  `Command plugin:fs|read_text_file not allowed by ACL`.
- **Rendering styles and charts.** Tauri injects runtime nonces into the app
  CSP. Under CSP Level 3, once a nonce/hash is present, browsers ignore
  `'unsafe-inline'`; the `blob:` iframe inherits that CSP, so every un-nonced
  `<style>` and inline `<script>` in a report was blocked. `prepareHtmlForPreview()`
  copies the host document's nonce onto the report's `<style>`, `<script>` and
  `<link>` tags. See the security section below for the CSP changes this needs.

The iframe keeps `sandbox="allow-scripts allow-forms allow-popups allow-modals"`
**without `allow-same-origin`**: previewed documents still run in an opaque
origin and cannot reach the parent DOM, Tauri IPC, app `localStorage`, or
`asset://` files.

### 2. Reliability fixes

- `src-tauri/src/lib.rs` — the `prefs` window now gets the same Rust-side
  `prevent_close()` + forced `destroy()` fallback as other windows. Previously,
  a hung WebView2 renderer could leave Preferences with a dead close button;
  that window has no native menu, so there was no second way to close it.
- `src-tauri/src/menu.rs` — `Close Window` keeps its normal renderer path and
  adds a delayed Rust-side `destroy()` fallback.
- `src-tauri/src/window_manager.rs` — show an existing hidden Preferences
  window before focusing it.
- `src/core/auth/AuthContext.jsx` — `checkAuthStatus()` now has a `catch` and an
  8 s timeout, so `isLoading` always clears (`AuthGate` otherwise blocks the
  whole Preferences window on a stalled auth probe).
- `src/contexts/RemoteConfigContext.jsx` — remote config fetch uses an
  `AbortController` with an 8 s timeout and falls back to `DEFAULT_CONFIG`.

### 3. In-app Siyuan-style workbench (live view)

`View → Open Workbench` (`Ctrl+Shift+Y`) opens a **second native WebView window**
that renders a note-taking workbench: six Chinese menu groups, a vertical dock
(document tree / tags / search / outline / settings), five notebooks, tabs,
breadcrumbs, Markdown tables and `[[wiki]]` links, an outline/property/tag
sidebar and a status bar. Light/dark theme, font size and open tabs persist in
`localStorage`.

This is **not** a generated HTML snapshot. `scan_workbench_docs` walks the
current workspace on every refresh, so new `.md`/`.html` files appear without
running any `sync` step.

- `src-tauri/src/workbench.rs` — `#[tauri::command] scan_workbench_docs`,
  `open_workbench_window`, `close_workbench_window`. Reads the workspace from
  `.settings.dat`, uses `walkdir` / `regex` / `chrono`, extracts H1/tags/outline,
  and returns a `WorkbenchSnapshot`. HTML files are indexed by `<title>` only;
  their bodies are loaded lazily. Skips `.git`, `node_modules`, `.lokus`,
  `reports`, `__pycache__` and the generated preview page.
- `src/views/Workbench.jsx` + `Workbench.css` + `workbenchModel.js` — the view
  and its pure, testable helpers (`collectTags`, `groupDocs`, `searchDocs`,
  `buildTagTree`, `wikiToMarkdown`, …).
- `src/main.jsx` — the `?view=workbench` window bypasses `AuthProvider`,
  `AuthGate`, `RemoteConfigProvider`, telemetry and PostHog entirely, so a
  stalled network probe cannot leave the workbench blank.
- `src-tauri/src/lib.rs` + `menu.rs` — window registration, menu entry and the
  same Rust-side close fallback used for Preferences.

The optional `lokus_archive.py` helper path shown in "copy command" dialogs is
derived from the **current user's home directory** by `default_skills_dir()`;
no machine-specific path is baked into the source. Override it with
`localStorage['lokus.wb.skills-dir']`. The workbench never writes to disk —
those dialogs only produce copyable commands.

HTML reports inside the workbench reuse `read_file_content` +
`prepareHtmlForPreview()` + a `blob:` iframe (see §1).

### 4. HTML encoding and URL rewriting

Two problems only show up for reports that are HTML *fragments* rather than
complete documents:

- **UTF-8.** `new Blob([html], { type: 'text/html' })` has no charset, so a
  zh-CN WebView2 decodes it with the system ANSI code page and turns Chinese
  text into mojibake. Both HTML channels now use
  `text/html;charset=utf-8`, and `prepareHtmlForPreview()` injects
  `<meta charset="utf-8">` when the fragment has no charset declaration
  (into `<head>` if present, otherwise at the front).
- **Root-relative URLs.** A `blob:` URL cannot resolve `/static/...` or
  `/api/...`. `prepareHtmlForPreview()` rewrites both to a configurable
  dashboard origin. It defaults to the loopback address
  `http://127.0.0.1:8090` — **no remote host is contacted by default**.
  Override or disable it:

```js
localStorage.setItem('lokus.dashboard-origin', 'http://127.0.0.1:9000');
localStorage.setItem('lokus.dashboard-origin', ''); // disable rewriting
```

**Known limitation:** the preview iframe deliberately omits
`allow-same-origin`, so its origin is opaque (`null`). A rewritten
`fetch('/api/…')` reaches the dashboard, but the dashboard must return an
`Access-Control-Allow-Origin` header or the request ends in
`TypeError: Failed to fetch`. This is a server-side CORS issue, not a rendering
or encoding bug. Fragments that depend on live dashboard data will show a
"读取失败" hint; fully self-contained reports render correctly.

### 5. Configuration

`src-tauri/tauri.conf.json` and **`src-tauri/tauri.windows.conf.json`** (the
Windows platform file *overrides* the main one) both relax the CSP; see below.
The CSP in both files must allow whichever dashboard origin you pick.

## ⚠️ Security trade-offs — read before using

To make `blob:` previews render real-world reports, this fork **deliberately
weakens the default CSP**:

- `dangerousDisableAssetCspModification: true` in both Tauri configs — disables
  Tauri's automatic nonce/hash hardening for app assets.
- `script-src` / `style-src` / `font-src` now permit `https:` (needed for CDN
  assets such as ECharts), and `script-src` includes `'unsafe-eval'`.
- `connect-src` additionally permits `http://127.0.0.1:8090`.

Consequences:

- The **sandbox iframe isolation remains intact**, but **XSS protection for the
  main app document is reduced**. Only preview HTML you trust; this is a local,
  single-user research build, not a hardened distribution.
- Reports that load charts from a public CDN need network access. Reports with
  all assets inlined work fully offline.
- A cleaner long-term design is to vendor chart libraries locally and inline
  them into the report, then remove `https:` from the allowlist again. That is
  not implemented here.

GitHub Actions are disabled on this fork. The upstream repository ships
workflows that can be triggered by external events (issues / comments) and drive
AI agents; those are inappropriate for a public personal fork.

## Building

Same toolchain as upstream (Node 18+, Rust, Tauri 2 prerequisites). On Windows:

```bash
npm install
npx vite build
npx tauri build --no-bundle
```

Note: a plain `cargo build --release` produces a **dev-mode** binary without the
embedded frontend — always build through the Tauri CLI.

Tests:

```bash
npx vitest run src/views/Workbench.test.jsx \
               src/components/HtmlViewer/HtmlViewerTab.test.jsx \
               src/contexts/RemoteConfigContext.test.jsx \
               src/core/auth/AuthGate.test.jsx
cargo test --manifest-path src-tauri/Cargo.toml --lib workbench::tests
```

`src-tauri/src/platform/windows.rs` also carries a one-line test-only import
fix: upstream's `test_invalid_path_handling` referenced `PlatformErrorKind`
without importing it, so `cargo test` would not compile at all. Runtime code
is unaffected.

Verification history on this fork:

- 38/38 frontend tests passing at the time the workbench landed (18
  `Workbench.test.jsx` + the existing suites).
- 4/4 Rust `workbench::tests` passing (notebook routing, Chinese tag order,
  date normalisation, home-derived skills directory).
- On one later sandbox run `vitest` hung at startup, so the UTF-8 / URL
  rewriting helper was additionally checked with a direct Node ESM import
  (8/8 assertions), with `vite build` used to validate the JSX.
- The final binary was verified on a real WebView2 window: the workbench
  renders all six menus, the dock, five notebooks, tabs and Markdown; complete
  HTML reports show their CSS, cards and `+0.7% / +0.8% / +5.7%` metric cards;
  HTML fragments display Chinese text correctly. See the CORS limitation in
  §4 for the one remaining data-side restriction.

## Reverting

Everything in this fork sits on top of `dea4909` on branch `neo/custom`.
To return to stock upstream behaviour, check out the base commit (local
`main`), or re-fork upstream. The unmodified upstream `LICENSE`, `README`
body and source tree are preserved.
