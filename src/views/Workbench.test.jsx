import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';

const invokeMock = vi.fn();
const listenMock = vi.fn(() => Promise.resolve(() => {}));

URL.createObjectURL = vi.fn(() => 'blob:mock-workbench');
URL.revokeObjectURL = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args) => invokeMock(...args),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args) => listenMock(...args),
}));

const SNAP = {
  workspace: String.raw`C:\notes\workspace`,
  skillsDir: String.raw`C:\notes\.workbuddy\skills\lokus-dual-archive\scripts`,
  generated: '2026-11-12 21:40',
  mdCount: 3,
  htmlCount: 1,
  notebooks: ['入口', '研判信息', '工作日志', '规则', 'HTML 报告'],
  docs: [
    {
      id: 'md:00-总入口.md', kind: 'md', nb: '入口', sub: '', title: '总入口',
      path: '00-总入口.md', absPath: String.raw`C:\notes\workspace\00-总入口.md`,
      date: '2026-11-12', tags: ['归档/类型/索引', 'type/index'],
      body: '# 总入口\n\n#归档/类型/索引 #type/index\n\n## 三区\n\n见 [[规则/整理纪律]]。\n',
      outline: [{ level: 1, text: '总入口' }, { level: 2, text: '三区' }],
      external: false, size: 120,
    },
    {
      id: 'md:规则/整理纪律.md', kind: 'md', nb: '规则', sub: '', title: '整理纪律',
      path: '规则/整理纪律.md', absPath: String.raw`C:\notes\workspace\规则\整理纪律.md`,
      date: '2026-11-07', tags: ['归档/类型/规则', '主题/流程规则', 'type/sop'],
      body: '# 整理纪律\n\n#归档/类型/规则 #主题/流程规则 #type/sop\n\n交易事实才进 25_交易日记。\n',
      outline: [{ level: 1, text: '整理纪律' }], external: false, size: 200,
    },
    {
      id: 'md:工作日志/2026-11/2026-11-12.md', kind: 'md', nb: '工作日志', sub: '2026-11',
      title: '2026-11-12 工作日志', path: '工作日志/2026-11/2026-11-12.md',
      absPath: String.raw`C:\notes\workspace\工作日志\2026-11\2026-11-12.md`,
      date: '2026-11-12', tags: ['归档/类型/日志', '主题/工作日志', 'type/log'],
      body: '# 2026-11-12 工作日志\n\n#归档/类型/日志 #type/log\n\n今日改源码。\n',
      outline: [{ level: 1, text: '2026-11-12 工作日志' }], external: false, size: 150,
    },
    {
      id: 'html:研判信息/HTML原件/report.html', kind: 'html', nb: 'HTML 报告', sub: '',
      title: '技术面分析报告', path: '研判信息/HTML原件/report.html',
      absPath: String.raw`C:\notes\workspace\研判信息\HTML原件\report.html`,
      date: '2026-10-29', tags: ['归档/类型/研判', 'type/report'],
      body: '', outline: [], external: true, size: 35000,
    },
  ],
};

import Workbench from './Workbench';
import {
  collectTags, groupDocs, searchDocs, wikiToMarkdown, buildTagTree,
  joinWorkspacePath, newLogTemplate, clampFont, MENUS, DOCK,
} from './workbenchModel.js';

describe('workbenchModel (pure)', () => {
  it('puts Chinese multi-level tags before ASCII fallbacks', () => {
    const tags = collectTags(SNAP.docs);
    const firstAscii = tags.findIndex(([t]) => /^[a-z]/.test(t));
    const lastChinese = tags.map(([t]) => t).reduce((n, t, i) => (/[^\x00-\x7f]/.test(t) ? i : n), -1);
    expect(lastChinese).toBeLessThan(firstAscii);
  });

  it('groups docs by notebook and by month sub-folder', () => {
    const groups = groupDocs(SNAP.docs);
    // NOTEBOOKS order: 入口 / 研判信息 / 工作日志 / 规则 / HTML 报告
    expect(groups.map((g) => g.id)).toEqual(['入口', '工作日志', '规则', 'HTML 报告']);
    const log = groups.find((g) => g.id === '工作日志');
    expect(log.groups[0].key).toBe('2026-11');
    expect(log.groups[0].docs).toHaveLength(1);
  });

  it('filters by query across title, path, tags and body', () => {
    // "整理纪律" hits both the rule doc and the wiki reference in 总入口 body.
    expect(searchDocs(SNAP.docs, '整理纪律', '')).toHaveLength(2);
    expect(searchDocs(SNAP.docs, '25_交易日记', '')).toHaveLength(1); // body-only hit
    expect(searchDocs(SNAP.docs, '', 'type/report')).toHaveLength(1);
    expect(searchDocs(SNAP.docs, '不存在的词', '')).toHaveLength(0);
  });

  it('turns [[wiki]] links into internal links', () => {
    expect(wikiToMarkdown('见 [[规则/整理纪律]] 与 [[A|B]]')).toBe(
      '见 [规则/整理纪律](wikilink:' + encodeURIComponent('规则/整理纪律') + ') 与 [B](wikilink:A)'
    );
  });

  it('builds an indented tag tree with group headers', () => {
    const rows = buildTagTree([['归档/类型/规则', 2], ['归档/类型/日志', 1], ['type/sop', 1]]);
    expect(rows[0]).toEqual({ type: 'group', label: '归档' });
    expect(rows.find((r) => r.label === '归档/类型/日志').depth).toBe(2);
    expect(rows.filter((r) => r.type === 'group')).toHaveLength(2);
  });

  it('joins Windows workspace paths correctly and clamps font', () => {
    expect(joinWorkspacePath(String.raw`C:\notes\workspace`, '规则/SOP.md'))
      .toBe(String.raw`C:\notes\workspace\规则\SOP.md`);
    expect(clampFont(500)).toBe(160);
    expect(clampFont(10)).toBe(70);
    expect(newLogTemplate('2026-11-12')).toContain('#归档/类型/日志');
  });

  it('has six menu groups and five dock views', () => {
    expect(MENUS.map((m) => m.name)).toEqual(['文件', '编辑', '视图', '跳转', '工具', '帮助']);
    expect(DOCK).toHaveLength(5);
    expect(MENUS.flatMap((m) => m.items).filter((i) => i !== '-').length).toBeGreaterThan(30);
  });
});

describe('Workbench component (live IPC smoke)', () => {
  beforeEach(() => {
    localStorage.clear();
    invokeMock.mockReset();
    URL.createObjectURL.mockClear();
    invokeMock.mockImplementation((cmd) => {
      if (cmd === 'scan_workbench_docs') return Promise.resolve(SNAP);
      if (cmd === 'read_file_content') return Promise.resolve('<html><title>R</title><body>ok</body></html>');
      if (cmd === 'close_workbench_window') return Promise.resolve();
      return Promise.resolve();
    });
  });

  afterEach(() => {
    document.documentElement.classList.remove('wb-window');
    delete document.documentElement.dataset.wbTheme;
    vi.restoreAllMocks();
  });

  const mount = () => render(<Workbench />);
  const ready = () => screen.findByText('总入口');

  it('loads from the live scan IPC and renders the notebook tree', async () => {
    mount();
    await ready();
    expect(invokeMock).toHaveBeenCalledWith('scan_workbench_docs');
    expect(screen.getByText('Lokus 工作台')).toBeTruthy();
    expect(document.querySelector('.wb-side-foot').textContent).toContain('4 篇文档');
    expect(document.querySelector('.wb-statusbar').textContent).toContain('实时扫盘');
  });

  it('opens the first document and renders markdown headings', async () => {
    mount();
    await ready();
    await waitFor(() => expect(screen.getAllByText('总入口').length).toBeGreaterThan(0));
    expect(screen.getAllByText('三区').length).toBeGreaterThan(0);
  });

  it('switches all five dock views without crashing', async () => {
    mount();
    await ready();
    const titles = { 文档树: '笔记本', 标签: '标签', 搜索: '搜索', 大纲: '大纲', 设置: '设置' };
    for (const [label, expectedTitle] of Object.entries(titles)) {
      fireEvent.click(screen.getByTitle(new RegExp('^' + label + ' \\(Alt\\+')));
      expect(document.querySelector('.wb-side-head').textContent).toContain(expectedTitle);
    }
  });

  it('opens every top menu and renders its items', async () => {
    mount();
    await ready();
    for (const m of MENUS) {
      const item = screen.getByText(m.name, { selector: '.wb-mitem' });
      fireEvent.click(item);
      const dropdown = document.querySelector('.wb-dropdown');
      expect(dropdown).toBeTruthy();
      expect(within(dropdown).getByText(m.items[0][0])).toBeTruthy();
      fireEvent.click(item); // close
    }
  });

  it('filters by tag and shows the matched document', async () => {
    mount();
    await ready();
    fireEvent.click(screen.getByTitle(/^标签 \(Alt\+/));
    fireEvent.click(screen.getByText('#type/report'));
    expect(screen.getByText(/筛选：#type\/report/)).toBeTruthy();
    expect(screen.getByText(/命中 1 篇/)).toBeTruthy();
  });

  it('searches the top box and shows results', async () => {
    mount();
    await ready();
    const input = screen.getByPlaceholderText('搜索文档 / 标签 / 正文');
    fireEvent.change(input, { target: { value: '25_交易日记' } });
    expect(document.querySelector('.wb-side-body').textContent).toContain('1 条结果');
  });

  it('opens an HTML report through read_file_content + blob iframe', async () => {
    mount();
    await ready();
    fireEvent.click(screen.getByText('技术面分析报告'));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('read_file_content',
      expect.objectContaining({ path: expect.stringContaining('report.html') })));
    await waitFor(() => expect(document.querySelector('iframe')).toBeTruthy());
    const blob = URL.createObjectURL.mock.calls.at(-1)?.[0];
    expect(blob.type).toBe('text/html;charset=utf-8');
    expect(await blob.text()).toContain('<meta charset="utf-8">');
  });

  it('toggles theme and font from the menu, persisting to localStorage', async () => {
    mount();
    await ready();
    fireEvent.click(screen.getByText('视图', { selector: '.wb-mitem' }));
    fireEvent.click(screen.getByText('切换日间 / 夜间'));
    await waitFor(() => expect(localStorage.getItem('lokus.wb.theme')).toBe('dark'));
    expect(document.documentElement.dataset.wbTheme).toBe('dark');

    fireEvent.click(screen.getByText('视图', { selector: '.wb-mitem' }));
    fireEvent.click(screen.getByText('放大字号'));
    await waitFor(() => expect(localStorage.getItem('lokus.wb.font')).toBe('110'));
  });

  it('closes a tab from its × button', async () => {
    mount();
    await ready();
    const before = document.querySelectorAll('.wb-tab').length;
    fireEvent.click(document.querySelector('.wb-tab .wb-x'));
    await waitFor(() => expect(document.querySelectorAll('.wb-tab').length).toBe(before - 1));
  });

  it('runs write-intent actions as copyable commands, never pretending to write', async () => {
    mount();
    await ready();
    fireEvent.click(screen.getByText('文件', { selector: '.wb-mitem' }));
    fireEvent.click(screen.getByText('新建今日工作日志'));
    expect(screen.getByText(/不直接写盘/)).toBeTruthy();
    expect(document.querySelector('.wb-card pre').textContent).toContain('lokus_archive.py');
  });

  it('shows a recoverable error when the scan fails', async () => {
    invokeMock.mockImplementationOnce(() => Promise.reject(new Error('NO_WORKSPACE')));
    mount();
    expect(await screen.findByText('无法读取工作区')).toBeTruthy();
    expect(screen.getByText('NO_WORKSPACE')).toBeTruthy();
    fireEvent.click(screen.getByText('重新扫描'));
    await waitFor(() => expect(screen.queryByText('无法读取工作区')).toBeNull());
  });
});
