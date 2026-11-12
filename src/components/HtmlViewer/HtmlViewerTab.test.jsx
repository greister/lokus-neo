import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const invokeMock = vi.fn();

// jsdom lacks URL.createObjectURL — stub it for the blob: URL path
URL.createObjectURL = vi.fn(() => 'blob:mock-html-url');
URL.revokeObjectURL = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args) => invokeMock(...args),
}));

import HtmlViewerTab from './HtmlViewerTab';
import {
  isHtmlFile,
  isHtmlPreviewEnabled,
  prepareHtmlForPreview,
  DASHBOARD_ORIGIN,
} from '../../utils/htmlUtils.js';

describe('isHtmlFile', () => {
  it('accepts .html and .htm in any case, rejects others', () => {
    expect(isHtmlFile('/ws/report.html')).toBe(true);
    expect(isHtmlFile('/ws/report.HTM')).toBe(true);
    expect(isHtmlFile('/ws/note.md')).toBe(false);
    expect(isHtmlFile('/ws/logo.png')).toBe(false);
    expect(isHtmlFile('')).toBe(false);
    expect(isHtmlFile(null)).toBe(false);
  });
});

describe('HtmlViewerTab', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    localStorage.removeItem('lokus.html-view');
  });
  afterEach(() => {
    localStorage.removeItem('lokus.html-view');
  });

  it('renders the HTML file in a sandboxed iframe (preview mode, default on)', async () => {
    const doc = '<!DOCTYPE html><!-- comment --><html><head><style>b{color:red}</style><script>1</script></head><body><h1>测算报告</h1></body></html>';
    invokeMock.mockResolvedValueOnce(doc);

    const { container } = render(<HtmlViewerTab filePath="/ws/report.html" />);

    await waitFor(() => {
      const iframe = container.querySelector('iframe');
      expect(iframe).toBeTruthy();
      expect(iframe.getAttribute('sandbox')).toBe(
        'allow-scripts allow-forms allow-popups allow-modals'
      );
      // no allow-same-origin: frame runs in an opaque origin
      expect(iframe.getAttribute('sandbox')).not.toContain('allow-same-origin');
      expect(iframe.getAttribute('src')).toMatch(/^blob:/);
    });
    expect(invokeMock).toHaveBeenCalledWith('read_file_content', { path: '/ws/report.html' });
  });

  it('falls back to a plain source view when the preview switch is off', async () => {
    localStorage.setItem('lokus.html-view', 'off');
    invokeMock.mockResolvedValueOnce(
      '<html><body><p>源码可见</p><!-- 注释也可见 --></body></html>'
    );

    const { container } = render(<HtmlViewerTab filePath="/ws/a.htm" />);

    await waitFor(() => {
      expect(container.querySelector('iframe')).toBeNull();
      expect(screen.getByText(/源码可见/)).toBeTruthy();
    });
    expect(screen.getByText(/注释也可见/)).toBeTruthy();
    expect(isHtmlPreviewEnabled()).toBe(false);
  });

  it('shows an error message when the file cannot be read', async () => {
    invokeMock.mockRejectedValueOnce(new Error('ENOENT'));

    render(<HtmlViewerTab filePath="/ws/missing.html" />);

    await waitFor(() => {
      expect(screen.getByText(/无法读取文件/)).toBeTruthy();
    });
  });
});

describe('prepareHtmlForPreview', () => {
  const hosts = [];
  afterEach(() => {
    hosts.splice(0).forEach((el) => el.remove());
  });

  function addHost(tag, nonce) {
    const el = document.createElement(tag);
    el.setAttribute('nonce', nonce);
    document.head.appendChild(el);
    hosts.push(el);
    return el;
  }

  it('copies the host CSP nonce onto report style / script / link tags', () => {
    addHost('style', 'STYLE123');
    addHost('script', 'SCRIPT456');

    const out = prepareHtmlForPreview(
      '<html><head><style>body{color:red}</style>' +
        '<link rel="stylesheet" href="x.css"><script>init()</script>' +
        '</head><body></body></html>'
    );

    expect(out).toContain('<style nonce="STYLE123">');
    expect(out).toContain('<link nonce="STYLE123"');
    expect(out).toContain('<script nonce="SCRIPT456">');
  });

  it('does not double-inject a nonce that is already present', () => {
    addHost('style', 'STYLE123');
    const out = prepareHtmlForPreview('<style nonce="own">a{}</style>');
    expect(out).toContain('<style nonce="own">a{}</style>');
    expect(out).not.toContain('nonce="STYLE123"');
  });

  it('declares UTF-8 for fragments that have no <head> or charset meta', () => {
    const out = prepareHtmlForPreview('<div class="widget">宏观空间</div>', '');
    expect(out.startsWith('<meta charset="utf-8">')).toBe(true);
    expect(out).toContain('<div class="widget">宏观空间</div>');
  });

  it('injects charset into <head> but never duplicates an existing one', () => {
    const withHead = prepareHtmlForPreview(
      '<html><head><title>R</title></head><body>正文</body></html>', '');
    expect(withHead).toContain('<head><meta charset="utf-8">');
    const already = prepareHtmlForPreview(
      '<html><head><meta charset="utf-8"></head><body>正文</body></html>', '');
    expect(already.match(/charset/gi)).toHaveLength(1);
  });

  it('rewrites root-relative /api/ calls as well as /static/ assets', () => {
    const out = prepareHtmlForPreview(
      '<script>fetch("/api/macro_calendar?days=21")</script>' +
        '<script src=\'/static/common.js\'></script>');
    expect(out).toContain(`fetch("${DASHBOARD_ORIGIN}/api/macro_calendar?days=21")`);
    expect(out).toContain(`src='${DASHBOARD_ORIGIN}/static/common.js'`);
  });

  it('rewrites root-relative /static/ assets to the 202 dashboard', () => {
    const out = prepareHtmlForPreview(
      '<script src="/static/common.js?v=1"></script>' +
        '<link rel="stylesheet" href="/static/site.css">'
    );
    expect(out).toContain(`src="${DASHBOARD_ORIGIN}/static/common.js?v=1"`);
    expect(out).toContain(`href="${DASHBOARD_ORIGIN}/static/site.css"`);
  });

  it('honours a configured dashboard origin and can disable rewriting', () => {
    const src = '<script src="/static/common.js"></script>';
    expect(prepareHtmlForPreview(src, 'http://127.0.0.1:9000')).toContain(
      'src="http://127.0.0.1:9000/static/common.js"'
    );
    const untouched = prepareHtmlForPreview(src, '');
    expect(untouched).toContain('src="/static/common.js"');
    expect(untouched).not.toContain('127.0.0.1');
  });

  it('keeps ordinary inline CSS and body markup intact', () => {
    const doc = '<style>b{color:red}</style><p>测算报告</p>';
    const out = prepareHtmlForPreview(doc);
    expect(out).toContain('b{color:red}');
    expect(out).toContain('<p>测算报告</p>');
  });
});
