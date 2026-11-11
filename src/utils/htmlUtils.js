/**
 * HTML utility functions for Lokus
 *
 * .html / .htm files are rendered in an embedded web view (HtmlViewerTab)
 * instead of the ProseMirror editor.
 */

export const HTML_EXTENSIONS = ['html', 'htm'];

/**
 * Check if a file path is an HTML file
 * @param {string} filePath - The file path to check
 * @returns {boolean} - True if the file is an HTML document
 */
export function isHtmlFile(filePath) {
  if (!filePath) return false;
  const lastDot = filePath.lastIndexOf('.');
  if (lastDot === -1) return false;
  const ext = filePath.substring(lastDot + 1).toLowerCase();
  return HTML_EXTENSIONS.includes(ext);
}

/**
 * Runtime toggle for the HTML preview feature.
 * Stored in localStorage so users can fall back to a plain source view.
 * Default: enabled ('' / unset / anything other than 'off').
 * @returns {boolean}
 */
export function isHtmlPreviewEnabled() {
  try {
    return localStorage.getItem('lokus.html-view') !== 'off';
  } catch {
    return true;
  }
}

/**
 * Enable / disable the HTML preview (persists in localStorage).
 * @param {boolean} enabled
 */
export function setHtmlPreviewEnabled(enabled) {
  try {
    localStorage.setItem('lokus.html-view', enabled ? 'on' : 'off');
  } catch {
    /* storage unavailable — toggle is session-only */
  }
}

/**
 * Optional origin for resolving root-relative `/static/...` assets in reports
 * exported from a self-hosted dashboard. Inside a `blob:` iframe those paths
 * resolve against the blob URL and 404, so they are rewritten.
 *
 * The default is a LOOPBACK address only — this fork never contacts a remote
 * host by default. Override it at runtime with
 * `localStorage.setItem('lokus.dashboard-origin', 'http://127.0.0.1:9000')`;
 * set it to an empty string to disable `/static/` rewriting entirely.
 * The CSP entries in `src-tauri/tauri*.conf.json` must allow the chosen origin.
 */
const DEFAULT_DASHBOARD_ORIGIN = 'http://127.0.0.1:8090';

/** @deprecated Prefer `getDashboardOrigin()` so the value can be overridden. */
export const DASHBOARD_ORIGIN = DEFAULT_DASHBOARD_ORIGIN;

export function getDashboardOrigin() {
  try {
    const configured = localStorage.getItem('lokus.dashboard-origin');
    if (configured === null) return DEFAULT_DASHBOARD_ORIGIN;
    return configured.replace(/\/+$/, '');
  } catch {
    // localStorage unavailable (e.g. SSR / restricted WebView): use default.
    return DEFAULT_DASHBOARD_ORIGIN;
  }
}

/**
 * Read a CSP nonce from the host document. Tauri injects `nonce="..."` into
 * index.html's <style> / external <script> tags at runtime; Chromium exposes
 * the value through the `.nonce` property (getAttribute may return '').
 */
function readNonce(selector) {
  try {
    if (typeof document === 'undefined') return '';
    const el = document.querySelector(selector);
    if (!el) return '';
    return el.nonce || el.getAttribute('nonce') || '';
  } catch {
    return '';
  }
}

function injectNonce(html, tagPattern, nonce) {
  if (!nonce) return html;
  return html.replace(tagPattern, (tag) => {
    if (/\snonce\s*=/i.test(tag)) return tag;
    return tag.replace(/<([a-zA-Z][a-zA-Z0-9-]*)/, `<$1 nonce="${nonce}"`);
  });
}

/**
 * Make a raw HTML report render correctly inside the sandboxed `blob:` iframe.
 *
 * Why this is needed:
 *  1. Tauri rewrites the app CSP at runtime, adding `'nonce-...'` (and/or
 *     hashes) to `script-src` / `style-src`. Per CSP Level 3, a nonce/hash
 *     source makes browsers IGNORE `'unsafe-inline'`. The blob iframe inherits
 *     that CSP, so every un-nonced `<style>` and inline `<script>` in a report
 *     is blocked — which is why previews showed unstyled, jumbled text.
 *     Copying the host document's nonce onto report tags re-authorises them.
 *  2. Reports exported from a self-hosted dashboard may reference
 *     `/static/...`, which cannot resolve from a `blob:` URL. Optionally
 *     rewrite them to a configurable origin (loopback by default).
 *
 * The iframe keeps `sandbox` WITHOUT `allow-same-origin`, so these documents
 * still run in an opaque origin and cannot reach the parent DOM or Tauri IPC.
 */
export function prepareHtmlForPreview(rawHtml, dashboardOrigin = getDashboardOrigin()) {
  if (typeof rawHtml !== 'string') return rawHtml;

  const styleNonce = readNonce('style[nonce]') || readNonce('link[nonce]');
  const scriptNonce = readNonce('script[nonce]');

  let out = injectNonce(rawHtml, /<style\b[^>]*>/gi, styleNonce);
  out = injectNonce(out, /<link\b[^>]*>/gi, styleNonce);
  out = injectNonce(out, /<script\b[^>]*>/gi, scriptNonce);

  if (dashboardOrigin) {
    out = out.replace(
      /(\b(?:src|href)\s*=\s*)(["'])\/static\//gi,
      `$1$2${dashboardOrigin}/static/`
    );
  }

  return out;
}
