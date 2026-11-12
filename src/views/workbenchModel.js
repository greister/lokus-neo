// Pure helpers for the in-app workbench. Kept dependency-free so they can be
// unit-tested without mounting React or a Tauri runtime.

export const NOTEBOOKS = [
  { id: '入口', icon: '◇', hint: '根目录入口文档' },
  { id: '研判信息', icon: '◆', hint: '投资研判 / 分析报告' },
  { id: '工作日志', icon: '▤', hint: '每天工作信息' },
  { id: '规则', icon: '▣', hint: 'SOP / 流程 / 纪律' },
  { id: 'HTML 报告', icon: '▧', hint: 'HTML 原件（实时读取）' },
];

export const DOCK = [
  { id: 'tree', icon: '▤', label: '文档树' },
  { id: 'tag', icon: '#', label: '标签' },
  { id: 'search', icon: '⌕', label: '搜索' },
  { id: 'outline', icon: '≣', label: '大纲' },
  { id: 'setting', icon: '⚙', label: '设置' },
];

export const DOCK_TITLES = {
  tree: '笔记本',
  tag: '标签',
  search: '搜索',
  outline: '大纲',
  setting: '设置',
};

// Six groups, mirroring the generated standalone workbench so the in-app view
// is a drop-in replacement. `act` values are dispatched in Workbench.jsx.
export const MENUS = [
  {
    name: '文件',
    items: [
      ['打开工作区总入口', 'actHome'],
      ['新建今日工作日志', 'actNewLog', 'Ctrl+N'],
      ['刷新工作区（实时扫盘）', 'actRefresh', 'Ctrl+R'],
      ['导出当前文档', 'actExport'],
      ['打印 / 存为 PDF', 'actPrint', 'Ctrl+P'],
      '-',
      ['关闭当前标签', 'actClose', 'Ctrl+W'],
      ['关闭全部标签', 'actCloseAll'],
      ['关闭工作台窗口', 'actQuit'],
    ],
  },
  {
    name: '编辑',
    items: [
      ['复制文档标题', 'actCopyTitle'],
      ['复制文档路径', 'actCopyPath'],
      ['复制全部标签', 'actCopyTags'],
      '-',
      ['页内 / 全局查找', 'actFind', 'Ctrl+F'],
      ['全选正文', 'actSelectAll'],
    ],
  },
  {
    name: '视图',
    items: [
      ['切换日间 / 夜间', 'actTheme', 'Ctrl+Shift+L'],
      ['显示 / 隐藏左栏', 'actSide', 'Ctrl+B'],
      ['显示 / 隐藏右栏', 'actRight', 'Ctrl+J'],
      '-',
      ['放大字号', 'actFontUp', 'Ctrl+='],
      ['缩小字号', 'actFontDown', 'Ctrl+-'],
      ['恢复 100%', 'actFontReset'],
    ],
  },
  {
    name: '跳转',
    items: [
      ['工作区总入口', 'go:总入口'],
      ['研判信息索引', 'go:研判信息/索引.md'],
      ['工作日志索引', 'go:工作日志/索引.md'],
      ['规则索引', 'go:规则/索引.md'],
      '-',
      ['最新工作日志', 'actLatestLog'],
      ['最新 HTML 报告', 'actLatestHtml'],
    ],
  },
  {
    name: '工具',
    items: [
      ['标签统计', 'actTagStat'],
      ['重建预览 / 索引', 'actSync'],
      ['复制工作区路径', 'actCopyWs'],
      ['归档技能命令', 'actSkillCmd'],
    ],
  },
  {
    name: '帮助',
    items: [
      ['快捷键一览', 'actKeys', 'F1'],
      ['关于本工作台', 'actAbout'],
    ],
  },
];

export const SHORTCUTS = [
  ['Ctrl+K / Ctrl+F', '全局搜索'],
  ['Ctrl+B', '左栏开关'],
  ['Ctrl+J', '右栏开关'],
  ['Ctrl+Shift+L', '日间 / 夜间'],
  ['Ctrl+= / Ctrl+-', '字号'],
  ['Ctrl+R', '重新扫盘'],
  ['Ctrl+W', '关闭标签'],
  ['Ctrl+N', '新建日志命令'],
  ['Alt+1 … Alt+5', '切换侧栏视图'],
  ['F1', '本帮助'],
  ['Esc', '关闭弹层'],
];

export function today() {
  const d = new Date();
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}

/** Tags with document counts, Chinese multi-level first, ASCII fallbacks last. */
export function collectTags(docs) {
  const counts = new Map();
  docs.forEach((d) => (d.tags || []).forEach((t) => counts.set(t, (counts.get(t) || 0) + 1)));
  return [...counts.entries()].sort((a, b) => {
    const cn = (s) => /[^\x00-\x7f]/.test(s) ? 0 : 1;
    return cn(a[0]) - cn(b[0]) || a[0].localeCompare(b[0], 'zh');
  });
}

/** Group docs by notebook, then by sub-folder (month for 工作日志). */
export function groupDocs(docs) {
  return NOTEBOOKS.map((nb) => {
    const list = docs.filter((d) => d.nb === nb.id);
    const groups = [];
    let current = null;
    list.forEach((d) => {
      const key = d.sub || '';
      if (!current || current.key !== key) {
        current = { key, docs: [] };
        groups.push(current);
      }
      current.docs.push(d);
    });
    return { ...nb, docs: list, groups };
  }).filter((nb) => nb.docs.length > 0);
}

/** Filter by free-text query and/or an exact tag. */
export function searchDocs(docs, query, tag) {
  const q = (query || '').trim().toLowerCase();
  return docs.filter((d) => {
    if (tag && !(d.tags || []).includes(tag)) return false;
    if (!q) return true;
    return `${d.title || ''} ${d.path || ''} ${(d.tags || []).join(' ')} ${d.body || ''}`
      .toLowerCase()
      .includes(q);
  });
}

/** Convert [[wiki]] links into clickable internal links without raw HTML. */
export function wikiToMarkdown(text) {
  return String(text || '').replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, target, label) => {
    const name = (target || '').trim();
    return `[${(label || name).trim()}](wikilink:${encodeURIComponent(name)})`;
  });
}

/** Turn a flat tag list into an indented tree for the sidebar. */
export function buildTagTree(entries) {
  const rows = [];
  let lastTop = null;
  entries.forEach(([tag, count]) => {
    const top = tag.split('/')[0];
    if (top !== lastTop) {
      rows.push({ type: 'group', label: top });
      lastTop = top;
    }
    rows.push({ type: 'tag', label: tag, count, depth: tag.split('/').length - 1 });
  });
  return rows;
}

export function joinWorkspacePath(workspace, rel) {
  if (!workspace || !rel) return rel || '';
  const sep = workspace.includes('\\') ? '\\' : '/';
  return `${workspace.replace(/[\\/]+$/, '')}${sep}${rel.replace(/\//g, sep)}`;
}

export function commandFor(sub, skillsDir) {
  const py = `python3 "${skillsDir}/lokus_archive.py"`;
  return `${py} ${sub}`;
}

export function newLogTemplate(date) {
  return `# ${date} 工作日志\n\n#归档/类型/日志 #主题/工作日志 #日期/${date} #type/log #date/${date}`;
}

export function clampFont(pct) {
  return Math.max(70, Math.min(160, Number(pct) || 100));
}
