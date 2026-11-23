/** @part-of ui.files */
import { useCallback, useEffect, useMemo, useState } from "react";

import { runCore, vaultFileUrl } from "../../bridge/core";
import { Icon } from "../../shell/Icon";
import { useStore } from "../../shell/store";
import { app } from "../../shell/workspace";
import { attachToChat } from "../ai/chat";
import { fileName, fileTag, kindOf, parseTable } from "./files";

/** The most rows of a table drawn at once; a bigger file says how many more it has. */
const ROWS = 1000;

interface Read {
  text: string;
  lines: number;
  more: boolean;
}

interface WholeFile {
  path: string;
  size: number;
  mime: string;
  kind: string;
  base64: string;
}

/* ---- Lokus Neo: in-app HTML report preview -------------------------------- */

/** Decodes base64 to a UTF-8 string (the report bytes come whole from `file.read`). */
function decodeUtf8(base64: string): string {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}

/**
 * Copy the host document's CSP nonce onto inline tags in a report. Under CSP3 a nonce makes
 * the browser ignore 'unsafe-inline', so a blob iframe would otherwise block all inline
 * <style> / <script>, killing charts and layout in saved reports.
 */
function withNonce(html: string): string {
  const nonce =
    document.querySelector('meta[property="csp-nonce"]')?.getAttribute("content") ??
    document.querySelector("script[nonce]")?.getAttribute("nonce") ??
    "";
  if (!nonce) return html;
  return html.replace(/<(style|script|link)\b([^>]*)>/gi, (_m, tag: string, attrs: string) => {
    if (/\bnonce\s*=/i.test(attrs)) return `<${tag}${attrs}>`;
    return `<${tag}${attrs} nonce="${nonce}">`;
  });
}

/** Make sure a fragment declares UTF-8, otherwise a zh-CN WebView decodes it as ANSI (mojibake). */
function ensureCharset(html: string): string {
  if (/<meta\s+charset\s*=/i.test(html) || /charset\s*=\s*utf-?8/i.test(html)) return html;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head([^>]*)>/i, '<head$1><meta charset="utf-8">');
  return `<meta charset="utf-8">${html}`;
}

/**
 * Root-relative URLs (/static/..., /api/...) cannot resolve inside a blob: iframe. Point them
 * at a loopback dashboard when one is running; empty string disables rewriting.
 */
function rewriteUrls(html: string, origin: string): string {
  if (!origin) return html;
  const base = origin.replace(/\/$/, "");
  return html.replace(/(["'(])(\/(?:static|api|assets)\/[^"')]*)/g, (_m, q: string, p: string) => `${q}${base}${p}`);
}

function HtmlView({ path }: { path: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const [mode, setMode] = useState<"preview" | "source">(() => {
    try {
      return localStorage.getItem("lokus.html.mode") === "source" ? "source" : "preview";
    } catch {
      return "preview";
    }
  });
  const [problem, setProblem] = useState("");
  const [origin] = useState(() => {
    try {
      return localStorage.getItem("lokus.dashboard-origin") ?? "http://127.0.0.1:8090";
    } catch {
      return "http://127.0.0.1:8090";
    }
  });

  useEffect(() => {
    let live = true;
    runCore<WholeFile>("file.read", { path }).then(
      (f) => {
        if (!live) return;
        const raw = decodeUtf8(f.base64);
        setHtml(ensureCharset(rewriteUrls(withNonce(raw), origin)));
      },
      (e) => {
        if (live) setProblem(e instanceof Error ? e.message : String(e));
      },
    );
    return () => {
      live = false;
    };
  }, [path, origin]);

  const switchMode = useCallback((next: "preview" | "source") => {
    setMode(next);
    try {
      localStorage.setItem("lokus.html.mode", next);
    } catch {
      /* storage disabled */
    }
  }, []);

  const srcDoc = useMemo(() => html ?? "", [html]);
  if (problem) return <p className="file-note">This report could not be read: {problem}</p>;
  if (html === null) return null;

  return (
    <div className="html-view">
      <div className="html-view-bar">
        <button className={mode === "preview" ? "on" : ""} onClick={() => switchMode("preview")}>
          预览
        </button>
        <button className={mode === "source" ? "on" : ""} onClick={() => switchMode("source")}>
          源码
        </button>
        <span className="html-view-hint">本地报告 · 仅在沙箱内渲染</span>
      </div>
      {mode === "preview" ? (
        <iframe title={fileName(path)} sandbox="allow-scripts allow-forms allow-popups allow-modals" srcDoc={srcDoc} />
      ) : (
        <pre className="file-text">{html}</pre>
      )}
    </div>
  );
}

function Table({ path }: { path: string }) {
  const [rows, setRows] = useState<string[][] | null>(null);
  const [more, setMore] = useState(false);
  const [problem, setProblem] = useState("");
  useEffect(() => {
    runCore<Read>("file.text", { path, max_chars: 2_000_000 }).then(
      (read) => {
        const all = parseTable(read.text, /\.tsv$/i.test(path));
        setMore(read.more || all.length > ROWS + 1);
        setRows(all.slice(0, ROWS + 1));
      },
      (e) => setProblem(e instanceof Error ? e.message : String(e)),
    );
  }, [path]);
  if (problem) return <p className="file-note">This file could not be read as a table: {problem}</p>;
  if (!rows) return null;
  if (!rows.length) return <p className="file-note">This file is empty.</p>;
  const [head, ...body] = rows;
  const numeric = head.map((_, c) => body.length > 0 && body.every((r) => !r[c] || /^-?[\d,.]+%?$|^[$€£]-?[\d,.]+$/.test(r[c].trim())));
  return (
    <div className="file-table">
      <table>
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={i} className={numeric[i] ? "num" : ""}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((r, i) => (
            <tr key={i}>
              {head.map((_, c) => (
                <td key={c} className={numeric[c] ? "num" : ""}>
                  {r[c] ?? ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {more && <p className="file-note">Showing the first {ROWS.toLocaleString()} rows.</p>}
    </div>
  );
}

function Text({ path }: { path: string }) {
  const [read, setRead] = useState<Read | null>(null);
  useEffect(() => {
    runCore<Read>("file.text", { path, max_chars: 400_000 }).then(setRead, () => setRead({ text: "", lines: 0, more: false }));
  }, [path]);
  if (!read) return null;
  return (
    <pre className="file-text">
      {read.text}
      {read.more ? "\n…" : ""}
    </pre>
  );
}

/** A file that is not a note, shown in the main area: a picture, a PDF, a table, or its text. */
export function FileView({ path }: { path: string }) {
  const vault = useStore(app, (s) => s.vault);
  if (!vault) return null;
  const kind = kindOf(path);
  const url = vaultFileUrl(vault.root, path);
  return (
    <div className="file-view">
      <header className="file-head">
        <strong>{fileName(path)}</strong>
        <span className="file-tag">{fileTag(path)}</span>
        <span className="file-space" />
        <button className="settings-button" onClick={() => attachToChat(path)}>
          <Icon name="assistant" size={13} /> Ask about this
        </button>
      </header>
      <div className={`file-body ${kind}`}>
        {kind === "image" && <img src={url} alt={fileName(path)} />}
        {kind === "pdf" && <iframe src={url} title={fileName(path)} />}
        {kind === "html" && <HtmlView path={path} />}
        {kind === "table" && <Table path={path} />}
        {kind === "text" && <Text path={path} />}
        {kind === "other" && <p className="file-note">Lokus cannot show this kind of file. It is in your workspace folder and opens in its own app.</p>}
      </div>
    </div>
  );
}
