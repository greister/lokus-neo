import React, { useEffect, useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  isHtmlPreviewEnabled,
  setHtmlPreviewEnabled,
  prepareHtmlForPreview,
} from '../../utils/htmlUtils.js';

/**
 * HtmlViewerTab — renders an .html/.htm file inside the app as a real web
 * page, in a sandboxed iframe.
 *
 * Security model:
 *   - The file is read through the app's own `read_file_content` IPC (the
 *     same channel the markdown editor uses), not `@tauri-apps/plugin-fs`.
 *     This keeps HTML tabs working for any workspace path without widening
 *     the fs plugin ACL/scope.
 *   - The file is read as text and turned into a `blob:` URL. `frame-src`
 *     already allows `blob:`; the `script-src` / `style-src` / `font-src`
 *     additions in BOTH tauri.conf.json and tauri.windows.conf.json are what
 *     let remote CDN assets and inline report styles actually load.
 *   - Before creating the Blob, `prepareHtmlForPreview()` copies the host
 *     document's CSP nonce onto the report's `<style>` / `<script>` / `<link>`
 *     tags and rewrites `/static/...` references. Without this, Tauri's
 *     runtime nonce injection makes the browser ignore `'unsafe-inline'`,
 *     so all inline CSS and chart scripts in the report get blocked.
 *   - The iframe is sandboxed with `allow-scripts allow-forms allow-popups`
 *     but WITHOUT `allow-same-origin`: the frame gets an opaque origin, so
 *     its scripts cannot reach the parent DOM, the Tauri IPC bridge,
 *     localStorage of the app, or read arbitrary local files via the
 *     asset:// protocol.
 *   - Documents that need external images/fonts still load them over
 *     https: (img-src allows https:), but local file references in the HTML
 *     cannot escape the sandbox.
 *
 * Toggle: the "预览 / 源码" button flips a localStorage-backed switch
 * (`lokus.html-view`), shared across tabs; when off, the raw source
 * (including <style>, <script>, <!-- comments -->) is shown as plain text.
 */
export default function HtmlViewerTab({ filePath }) {
  const [html, setHtml] = useState(null);
  const [error, setError] = useState(null);
  const [preview, setPreview] = useState(isHtmlPreviewEnabled());
  const [blobUrl, setBlobUrl] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setHtml(null);
    setError(null);
    invoke('read_file_content', { path: filePath })
      .then((content) => {
        if (!cancelled) setHtml(content);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [filePath]);

  // (Re)create the blob URL whenever the content or mode changes.
  useEffect(() => {
    if (!preview || html == null) return undefined;
    const url = URL.createObjectURL(
      new Blob([prepareHtmlForPreview(html)], { type: 'text/html;charset=utf-8' })
    );
    setBlobUrl(url);
    return () => {
      URL.revokeObjectURL(url);
      setBlobUrl(null);
    };
  }, [html, preview]);

  const toggle = useCallback(() => {
    setPreview((p) => {
      setHtmlPreviewEnabled(!p);
      return !p;
    });
  }, []);

  if (error) {
    return (
      <div className="h-full flex items-center justify-center text-app-muted">
        <div className="text-center">
          <div className="text-2xl mb-2">⚠️</div>
          <div className="text-sm">无法读取文件：{error}</div>
          <div className="text-xs mt-1 opacity-60">{filePath}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-white">
      <div className="flex items-center justify-between px-3 py-1 border-b border-black/10 bg-neutral-50 text-xs text-neutral-600 shrink-0">
        <span className="truncate" title={filePath}>
          🌐 {filePath}
        </span>
        <button
          type="button"
          onClick={toggle}
          className="px-2 py-0.5 rounded border border-neutral-300 bg-white hover:bg-neutral-100"
          title="切换网页渲染 / 源码视图（对全部 HTML 标签生效，持久保存）"
        >
          {preview ? '预览中 · 切到源码' : '源码中 · 切到预览'}
        </button>
      </div>

      {html == null ? (
        <div className="flex-1 flex items-center justify-center text-neutral-400 text-sm">
          Loading…
        </div>
      ) : preview ? (
        <iframe
          title={filePath}
          src={blobUrl ?? undefined}
          className="flex-1 w-full border-0 bg-white"
          sandbox="allow-scripts allow-forms allow-popups allow-modals"
        />
      ) : (
        <pre className="flex-1 overflow-auto p-4 text-xs leading-relaxed text-neutral-800 whitespace-pre-wrap">
          {html}
        </pre>
      )}
    </div>
  );
}
