console.log('app.js loaded');
class DashboardApp {
  constructor() {
    this.config = null;
    this.dockerContainers = [];
    this.recentMediaItems = [];
    this.lastRecentIds = new Set();
    this.activeDownloadsCount = 0;
    this.searchQuery = '';
    this.searchFlatResults = [];
    this.selectedResultIndex = 0;
    this.isEditMode = false;
    this.sse = null;
    this.editingItem = null; // { type, index }

    this.init();
  }

  getScreenAssignment() {
    const params = new URLSearchParams(window.location.search);
    return parseInt(params.get('screen') || '1', 10);
  }

  shouldShowWidget(widgetName) {
    if (!this.displayConfig || !this.displayConfig.widgets || !this.displayConfig.widgets[widgetName]) return false;
    return this.displayConfig.widgets[widgetName].includes(this.screenId);
  }

  async init() {
    console.log('[Init] Starting...');
    try {
      this.setupClock();
      this.setupPortrait();
      this.bindEvents();
      console.log('[Init] Setup done');

      await this.fetchConfig();
      console.log('[Init] Config fetched:', this.config);
      
      this.displayConfig = await (await fetch('/api/display')).json();
      console.log('[Init] Display config fetched:', this.displayConfig);
      
      this.screenId = this.getScreenAssignment();
      console.log('[Init] ScreenId:', this.screenId);
      
      this.fullRender();
      console.log('[Init] Rendered');

      this.fetchDockerContainers();
      this.fetchDownloads();
      this.fetchContainerHealth();
      this.fetchRecentMedia();
      this.setupSSE();

      const bgLayer = document.getElementById('bg-layer');
      bgLayer.style.backgroundImage = `url('/background.jpg?t=${Date.now()}')`;
      
      // Position background to span across monitors
      // Screen 1: Left, Screen 2: Center, Screen 3: Right
      const positions = ['0% 50%', '50% 50%', '100% 50%'];
      bgLayer.style.setProperty('background-position', positions[this.screenId - 1] || 'center', 'important');
      bgLayer.style.setProperty('background-size', '300% 100%', 'important');

      setInterval(() => this.fetchSystemStats(), 5000);
      setInterval(() => this.fetchDockerContainers(), 15000);
      setInterval(() => this.fetchDownloads(), 5000);
      setInterval(() => this.fetchContainerHealth(), 5000);
      setInterval(() => this.fetchRecentMedia(), 60000);

      lucide.createIcons();
      console.log('[Init] Finished');
    } catch (e) {
      console.error('[Init] Failed:', e);
    }
  }

  homeDir() {
    return this.config?.system?.home_dir || '/';
  }

  setupPortrait() {
    const party = ['gustave', 'lune', 'maelle', 'monoco', 'sciel', 'verso'];
    const dayIndex = Math.floor(Date.now() / 86400000);
    const name = party[dayIndex % party.length];
    const img = document.getElementById('logo-portrait');
    img.src = `assets/e33/portraits/${name}.png`;
    img.alt = name;
    img.title = name.charAt(0).toUpperCase() + name.slice(1);
  }

  setupClock() {
    const updateTime = () => {
      const now = new Date();
      document.getElementById('clock-display').innerText = now.toLocaleTimeString('en-US', {
        hour12: false, hour: '2-digit', minute: '2-digit',
      });
      document.getElementById('date-display').innerText = now.toLocaleDateString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric',
      });
    };
    updateTime();
    setInterval(updateTime, 1000);
  }

  bindEvents() {
    document.getElementById('btn-wallpaper').onclick = () => this.randomizeWallpaper();
    document.getElementById('btn-edit-mode').onclick = () => this.toggleEditMode();

    const searchInput = document.getElementById('global-search');
    searchInput.oninput = (e) => {
      this.searchQuery = e.target.value.toLowerCase();
      this.renderSearchResults();
    };
    searchInput.onfocus = () => this.renderSearchResults();
    searchInput.onblur = () => setTimeout(() => this.closeSearchResults(), 150);
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        searchInput.value = '';
        this.searchQuery = '';
        searchInput.blur();
        this.closeSearchResults();
      }
      else if (e.key === 'Enter') { e.preventDefault(); this.activateSelectedResult(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); this.moveResultSelection(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); this.moveResultSelection(-1); }
    });
    document.addEventListener('keydown', (e) => {
      const typingElsewhere = ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName);
      if (typingElsewhere) return;

      if (e.key === '/') {
        e.preventDefault();
        searchInput.focus();
        return;
      }
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        searchInput.focus();
      }
    });
  }

  setupSSE() {
    if (this.sse) this.sse.close();
    this.sse = new EventSource('/api/events');
    this.sse.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'config_reload') {
          this.config = msg.data;
          this.fullRender();
          this.showToast('Configuration updated from server');
        } else if (msg.type === 'background_change') {
          document.getElementById('bg-layer').style.backgroundImage = `url('/background.jpg?t=${Date.now()}')`;
        }
      } catch (err) { /* ignore */ }
    };
  }

  async fetchConfig() {
    try {
      const res = await fetch('/api/config');
      this.config = await res.json();
      this.fullRender();
    } catch (err) {
      this.showToast('Failed to fetch config');
    }
  }

  async fetchDockerContainers() {
    try {
      const res = await fetch('/api/docker/containers');
      this.dockerContainers = await res.json();
    } catch (err) { /* ignore */ }
  }

  async fetchDownloads() {
    const widget = document.getElementById('widget-downloads');
    const el = document.getElementById('downloads-list');
    try {
      const res = await fetch('/api/downloads/active');
      const items = await res.json();
      this.activeDownloadsCount = items.length;
      if (!items.length) { widget.style.display = 'none'; this.renderRecentGrid(); return; }
      widget.style.display = this.shouldShowWidget('downloads') ? '' : 'none';
      el.innerHTML = items.map(d => `
        <div class="vital-item" style="margin-top: 6px;">
          <div class="vital-label mount-leaf" style="width: auto; font-size: 10.5px; max-width: 130px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${d.name}">${d.name}</div>
          <div class="progress-track" style="margin-left: 8px; height: 4px;"><div class="progress-fill" style="width: ${d.progress}%;"></div></div>
          <div class="vital-val" style="width: 28px; font-size: 10.5px;">${d.progress}%</div>
        </div>
      `).join('');
      this.renderRecentGrid();
    } catch (err) {
      widget.style.display = 'none';
      this.activeDownloadsCount = 0;
      this.renderRecentGrid();
    }
  }

  async fetchContainerHealth() {
    const widget = document.getElementById('widget-health');
    const el = document.getElementById('health-list');
    try {
      const res = await fetch('/api/docker/unhealthy');
      const items = await res.json();
      if (!items.length) { widget.style.display = 'none'; this.renderRecentGrid(); return; }
      widget.style.display = this.shouldShowWidget('container_health') ? '' : 'none';
      el.innerHTML = items.map(c => `
        <div class="health-item">
          <span class="dot" style="background: var(--danger);"></span>
          <div style="flex:1; min-width:0;">
            <div class="health-name">${c.name}</div>
            <div class="health-status">${c.status}</div>
          </div>
          <button class="icon-btn-sm" title="View logs" data-logs-name="${c.name}"><i data-lucide="scroll-text"></i></button>
        </div>
      `).join('');
      el.querySelectorAll('[data-logs-name]').forEach(btn => {
        btn.onclick = () => this.openLogsModal(btn.dataset.logsName);
      });
      lucide.createIcons();
      this.renderRecentGrid();
    } catch (err) {
      widget.style.display = 'none';
      this.renderRecentGrid();
    }
  }

  async openLogsModal(name) {
    this.currentLogsContainer = name;
    document.getElementById('logs-modal-title').innerText = `Logs: ${name}`;
    document.getElementById('logs-content').innerText = 'Loading...';
    document.getElementById('logs-modal').classList.add('open');
    await this.refreshLogs();
  }

  closeLogsModal() {
    document.getElementById('logs-modal').classList.remove('open');
    this.currentLogsContainer = null;
  }

  async refreshLogs() {
    const name = this.currentLogsContainer;
    if (!name) return;
    const el = document.getElementById('logs-content');
    try {
      const res = await fetch(`/api/docker/logs/${encodeURIComponent(name)}`);
      const data = await res.json();
      this.renderLogLines(el, data.logs || data.error || '(no log output)');
    } catch (err) {
      el.innerText = 'Failed to fetch logs.';
    }
  }

  renderLogLines(el, text) {
    const lines = text.split('\n');
    const lengths = lines.map(l => l.length).filter(len => len > 0).sort((a, b) => a - b);
    const median = lengths.length ? lengths[Math.floor(lengths.length / 2)] : 0;
    const threshold = median * 1.5;
    const escapeHtml = (s) => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    el.innerHTML = lines.map(line => {
      const wrap = median > 0 && line.length > threshold;
      return `<div class="log-line${wrap ? ' wrap' : ''}">${escapeHtml(line)}</div>`;
    }).join('');
    el.scrollTop = el.scrollHeight;
  }

  openDockhand() {
    const url = this.config?.dockhand?.url || this.config?.bookmarks?.find(b => b.name === 'Dockhand Client')?.url;
    if (!url) return this.showToast('Set dockhand.url in config.yaml to use this button');
    this.openExternal(url);
  }

  async fetchRecentMedia() {
    try {
      const res = await fetch('/api/media/recent');
      this.recentMediaItems = await res.json();
      this.renderRecentGrid();
    } catch (err) { /* ignore */ }
  }

  recentTypeIcon(type) {
    const icons = {
      Movie: '<path d="M3 9l1.5-4h15L18 9Z"/><rect x="3" y="9" width="18" height="11" rx="1.2"/><path d="M7 5l2 4M13 5l2 4"/>',
      Series: '<rect x="3" y="5" width="18" height="13" rx="1.5"/><path d="M8 21h8M12 18v3"/>',
      Episode: '<rect x="3" y="5" width="18" height="13" rx="1.5"/><path d="M8 21h8M12 18v3"/>',
      Video: '<rect x="3" y="5" width="18" height="14" rx="1.5"/><path d="M10 9l5 3-5 3Z" fill="currentColor" stroke="none"/>',
      Photo: '<rect x="3" y="4" width="18" height="16" rx="1.5"/><circle cx="8.5" cy="9" r="1.5"/><path d="M3 16l5-5 4 4 4-4 5 5"/>',
    };
    const path = icons[type] || icons.Photo;
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
  }

  computeRecentCapacity() {
    const column = document.querySelector('.widget-column-right');
    const dlWidget = document.getElementById('widget-downloads');
    const healthWidget = document.getElementById('widget-health');
    const recentWidget = document.getElementById('widget-recent');
    const header = recentWidget.querySelector('.widget-header');
    const grid = document.getElementById('recent-grid');
    if (!column || !grid) return 9;

    const visibleSiblingHeight = dlWidget.offsetHeight + healthWidget.offsetHeight;
    const visibleSiblingCount = (dlWidget.offsetHeight > 0 ? 1 : 0) + (healthWidget.offsetHeight > 0 ? 1 : 0);
    const columnGap = 14; 
    const consumedBySiblings = visibleSiblingHeight + visibleSiblingCount * columnGap;

    const widgetStyle = getComputedStyle(recentWidget);
    const chrome = header.offsetHeight
      + parseFloat(getComputedStyle(header).marginBottom)
      + parseFloat(widgetStyle.paddingTop) + parseFloat(widgetStyle.paddingBottom);

    const availableForGrid = column.clientHeight - consumedBySiblings - chrome;

    const gridGap = 8; 
    const colWidth = (grid.clientWidth - gridGap * 2) / 3;
    const rowHeight = colWidth * 1.5; 
    if (rowHeight <= 0) return 9;

    const rows = Math.floor((availableForGrid + gridGap) / (rowHeight + gridGap));
    return Math.min(18, Math.max(3, rows * 3));
  }

  renderRecentGrid() {
    const el = document.getElementById('recent-grid');
    const items = this.recentMediaItems || [];
    const maxItems = this.computeRecentCapacity();
    const shown = items.slice(0, maxItems);

    const shownKey = shown.map(m => m.id).join(',');
    if (shownKey === this.lastRenderedShownKey) return;
    this.lastRenderedShownKey = shownKey;

    const previouslySeen = this.lastRecentIds || new Set();

    el.innerHTML = shown.map((m, idx) => {
      const isNew = !previouslySeen.has(m.id);
      return `
      <div class="recent-item source-${m.source}${isNew ? ' is-new' : ''}" ${isNew ? `style="animation-delay: ${idx * 45}ms"` : ''} title="${m.title}" data-idx="${idx}">
        <img src="${m.thumbUrl}" alt="" loading="lazy">
        ${m.episodeCode ? `<span class="recent-episode-badge">${m.episodeCode}</span>` : ''}
        <span class="recent-type-badge">${this.recentTypeIcon(m.type)}</span>
        <div class="recent-title"><div class="recent-title-text">${m.title}</div></div>
      </div>
    `;
    }).join('');
    this.lastRecentIds = new Set(shown.map(m => m.id));

    el.querySelectorAll('.recent-item').forEach(node => {
      const item = items[+node.dataset.idx];
      node.onclick = () => this.openExternal(item.linkUrl);
    });
  }

  renderDiskTree(disks) {
    const root = {};
    disks.forEach(d => {
      const parts = d.mount.split('/').filter(Boolean);
      if (!parts.length) { root['/'] = { __leaf: d }; return; }
      let node = root;
      parts.forEach((part, i) => {
        node[part] = node[part] || {};
        if (i === parts.length - 1) node[part].__leaf = d;
        node = node[part];
      });
    });

    const bar = (name, d, depth) => `
      <div class="vital-item disk-row" style="margin-top: 6px; padding-left: ${depth * 14}px;" data-mount="${d.mount}" title="Open ${d.mount} in Dolphin">
        <div class="vital-label mount-leaf" style="width: 82px; font-size: 10px;">${name}</div>
        <div class="progress-track" style="margin-left: 8px; height: 4px;"><div class="progress-fill" style="width: ${d.use}%; background: var(--accent-dim); box-shadow: none;"></div></div>
        <div class="vital-val" style="width: 24px; font-size: 10px;">${Math.round(d.use)}%</div>
      </div>`;
    const groupLabel = (name, depth) => `
      <div class="mount-group" style="margin-top: 8px; padding-left: ${depth * 14}px;">${name}</div>`;

    const walk = (node, depth) => {
      let html = '';
      Object.keys(node).forEach(key => {
        if (key === '__leaf') return;
        const child = node[key];
        const childKeys = Object.keys(child).filter(k => k !== '__leaf');
        if (childKeys.length === 0) {
          html += bar(key, child.__leaf, depth);
        } else if (child.__leaf) {
          html += bar(key, child.__leaf, depth);
          html += walk(child, depth + 1);
        } else {
          html += groupLabel(key, depth);
          html += walk(child, depth + 1);
        }
      });
      return html;
    };

    return walk(root, 0);
  }

  async fetchSystemStats() {
    try {
      const res = await fetch('/api/system/stats');
      const stats = await res.json();

      const cpuVal = Math.round(stats.cpu.load);
      const cpuBar = document.getElementById('cpu-bar');
      cpuBar.style.width = cpuVal + '%';
      cpuBar.classList.toggle('critical', cpuVal >= 85);
      document.getElementById('cpu-val').innerText = cpuVal + '%';

      const ramPercent = Math.round(stats.memory.usedPercent);
      const ramBar = document.getElementById('ram-bar');
      ramBar.style.width = ramPercent + '%';
      ramBar.classList.toggle('critical', ramPercent >= 85);
      document.getElementById('ram-val').innerText = ramPercent + '%';

      document.querySelector('.portrait-frame')?.classList.toggle('critical', Math.max(cpuVal, ramPercent) >= 85);

      const diskVitalsEl = document.getElementById('disk-vitals');
      diskVitalsEl.innerHTML = this.renderDiskTree(stats.disk);
      diskVitalsEl.querySelectorAll('.disk-row').forEach(el => {
        el.onclick = () => this.executeCmd(`dolphin "${el.dataset.mount}"`, this.homeDir());
      });

      const s = stats.os.uptime;
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      document.getElementById('uptime-display').innerText = `${h}h ${m}m up`;
    } catch (err) { /* ignore */ }
  }

  fullRender() {
    if (!this.config) return;
    if (this.config.ui) {
      if (this.config.ui.title) {
        document.title = this.config.ui.title;
        const logo = document.getElementById('logo-text');
        if (logo) logo.innerText = this.config.ui.title;
      }
      
      const widgetMap = { 
        'widget-downloads': 'downloads', 
        'widget-health': 'container_health', 
        'widget-recent': 'media_recent',
        'widget-vitals': 'vitals',
        'widget-bookmarks': 'bookmarks',
        'widget-folders': 'folders'
      };
      
      Object.entries(widgetMap).forEach(([id, configKey]) => {
        const el = document.getElementById(id);
        if (el) {
          const show = this.shouldShowWidget(configKey);
          el.style.setProperty('display', show ? '' : 'none', 'important');
        }
      });
      document.documentElement.style.setProperty('--accent-color', this.config.ui.accent_color);
    }
    this.renderShortcuts(this.config.bookmarks, 'bookmarks-grid', 'bookmark', 'globe');
    this.renderShortcuts(this.config.quick_links, 'folders-grid', 'shortcut', 'folder');
    lucide.createIcons();
  }

  getIconHtml(iconStr, fallback) {
    if (!iconStr) return `<i data-lucide="${fallback}"></i>`;
    iconStr = iconStr.trim();
    if (iconStr.startsWith('<')) return iconStr;
    if (iconStr.startsWith('http') || iconStr.includes('.')) {
      return `<img src="${iconStr}" style="border-radius:4px;width:18px;height:18px;object-fit:contain;">`;
    }
    const emojiMap = {
      '🚀': 'rocket', '🐳': 'box', '🤖': 'bot', '🐚': 'terminal', '🌐': 'globe',
      '📂': 'folder-open', '📁': 'folder', '📥': 'download', '🎬': 'film', '🎭': 'theater',
      '📖': 'book', '📚': 'book-open', '🎶': 'music', '🏺': 'package', '🛠️': 'wrench',
      '🛠': 'wrench', '📊': 'bar-chart-2', '🦅': 'eye', '🔗': 'link', '☁️': 'cloud',
    };
    if (emojiMap[iconStr]) return `<i data-lucide="${emojiMap[iconStr]}"></i>`;
    if (/^[a-z0-9-]+$/i.test(iconStr)) return `<i data-lucide="${iconStr}"></i>`;
    for (const [emoji, lucideName] of Object.entries(emojiMap)) {
      if (iconStr.includes(emoji)) return `<i data-lucide="${lucideName}"></i>`;
    }
    return `<span style="font-size:16px;line-height:1;">${iconStr}</span>`;
  }

  renderShortcuts(items, containerId, editType, fallbackIcon) {
    const container = document.getElementById(containerId);
    let html = '';
    (items || []).forEach((item, idx) => {
      html += `
        <a class="link-item" onclick="app.handleShortcutClick(event, '${editType}', ${idx})">
          ${this.getIconHtml(item.icon, fallbackIcon)}
          <span>${item.name}</span>
          <div class="edit-btn edit-only" onclick="event.stopPropagation(); app.openEditModal('${editType}', ${idx})">
            <i data-lucide="edit-3"></i>
          </div>
        </a>
      `;
    });
    container.innerHTML = html;
  }

  handleShortcutClick(e, type, idx) {
    e.preventDefault();
    if (this.isEditMode) return;
    if (type === 'bookmark') {
      this.openExternal(this.config.bookmarks[idx].url);
    } else {
      const p = this.config.quick_links[idx].path;
      this.executeCmd(`dolphin "${p}"`, this.homeDir());
    }
  }

  renderSearchResults() {
    const box = document.getElementById('search-results');
    const q = this.searchQuery;
    this.searchFlatResults = [];
    if (!q || !this.config) { this.closeSearchResults(); return; }

    const match = (s) => (s || '').toLowerCase().includes(q);
    const groups = [
      { label: 'Bookmarks', icon: 'bookmark', items: (this.config.bookmarks || []).filter(b => match(b.name) || match(b.url)).slice(0, 6).map(b => ({ name: b.name, meta: b.url, action: () => this.openExternal(b.url) })) },
      { label: 'Folders', icon: 'folder', items: (this.config.quick_links || []).filter(f => match(f.name) || match(f.path)).slice(0, 6).map(f => ({ name: f.name, meta: f.path, action: () => this.executeCmd(`dolphin "${f.path}"`, this.homeDir()) })) },
      { label: 'Containers', icon: 'box', items: (this.dockerContainers || []).filter(c => match(c.name)).slice(0, 6).map(c => ({ name: c.name, meta: `:${c.port}`, action: () => this.openExternal(`http://localhost:${c.port}`) })) },
    ].filter(g => g.items.length > 0);

    if (!groups.length) {
      box.innerHTML = `<div class="search-empty">No matches for "${q}"</div>`;
      box.classList.add('open');
      return;
    }

    let html = '';
    let flatIdx = 0;
    groups.forEach((g) => {
      html += `<div class="search-result-group-label">${g.label}</div>`;
      g.items.forEach((item) => {
        html += `
          <div class="search-result-item" data-idx="${flatIdx}">
            <i data-lucide="${g.icon}"></i>
            <span class="srname">${item.name}</span>
            <span class="srmeta">${item.meta || ''}</span>
          </div>
        `;
        this.searchFlatResults.push(item);
        flatIdx++;
      });
    });
    box.innerHTML = html;
    box.classList.add('open');
    lucide.createIcons();

    this.selectedResultIndex = 0;
    this.highlightSelectedResult();

    box.querySelectorAll('.search-result-item').forEach(el => {
      const idx = +el.dataset.idx;
      el.onmouseenter = () => { this.selectedResultIndex = idx; this.highlightSelectedResult(); };
      el.onmousedown = (e) => { e.preventDefault(); this.searchFlatResults[idx].action(); this.closeSearchResults(); };
    });
  }

  highlightSelectedResult() {
    const box = document.getElementById('search-results');
    box.querySelectorAll('.search-result-item').forEach(el => {
      el.classList.toggle('selected', +el.dataset.idx === this.selectedResultIndex);
    });
    box.querySelector('.search-result-item.selected')?.scrollIntoView({ block: 'nearest' });
  }

  moveResultSelection(delta) {
    const n = (this.searchFlatResults || []).length;
    if (!n) return;
    this.selectedResultIndex = (this.selectedResultIndex + delta + n) % n;
    this.highlightSelectedResult();
  }

  activateSelectedResult() {
    const item = (this.searchFlatResults || [])[this.selectedResultIndex];
    if (!item) return;
    item.action();
    document.getElementById('global-search').blur();
    this.closeSearchResults();
  }

  closeSearchResults() {
    document.getElementById('search-results').classList.remove('open');
  }

  async executeCmd(cmd, cmdPath) {
    try {
      const res = await fetch('/api/action/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cmd, path: cmdPath }),
      });
      const data = await res.json();
      if (!data.success) this.showToast('Error: ' + data.error);
    } catch (err) {
      this.showToast('Network error executing command');
    }
  }

  async openExternal(url) {
    try {
      await fetch('/api/action/url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
    } catch (err) { /* ignore */ }
  }

  async randomizeWallpaper() {
    this.showToast('Loading random wallpaper...');
    try {
      await fetch('/api/background/randomize', { method: 'POST' });
    } catch (err) { /* ignore */ }
  }

  launchKonsole() { this.executeCmd('konsole', this.homeDir()); }
  launchUpdate() {
    const cmd = this.config?.system?.update_command || 'zsh -i -c "update; exec zsh"';
    this.executeCmd(`konsole -e ${cmd}`, this.homeDir());
  }

  showToast(msg) {
    const t = document.getElementById('toast');
    t.innerText = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 3000);
  }

  toggleEditMode() {
    this.isEditMode = !this.isEditMode;
    document.body.classList.toggle('edit-mode', this.isEditMode);
    document.getElementById('btn-edit-mode').style.color = this.isEditMode ? 'var(--accent-color)' : 'white';
    if (this.isEditMode) this.showToast('Edit Mode Enabled. Click edit icons on elements.');
  }

  addBookmark() { this.openEditModal('bookmark', this.config.bookmarks.length); }
  addFolder() { this.openEditModal('shortcut', this.config.quick_links.length); }

  openEditModal(type, index) {
    this.editingItem = { type, index };
    const modal = document.getElementById('edit-modal');

    let initialName = '', initialPath = '', initialIcon = '';
    if (type === 'bookmark') {
      const b = this.config.bookmarks[index];
      if (b) { initialName = b.name; initialPath = b.url; initialIcon = b.icon; }
      document.getElementById('modal-title').innerText = b ? 'Edit Bookmark' : 'Add Bookmark';
    } else if (type === 'shortcut') {
      const s = this.config.quick_links[index];
      if (s) { initialName = s.name; initialPath = s.path; initialIcon = s.icon; }
      document.getElementById('modal-title').innerText = s ? 'Edit Folder' : 'Add Folder';
    }

    document.getElementById('edit-name').value = initialName;
    document.getElementById('edit-path').value = initialPath;
    document.getElementById('edit-icon').value = initialIcon;

    modal.classList.add('open');
    document.getElementById('btn-save-edit').onclick = () => this.saveEdit();
  }

  closeModal() {
    document.getElementById('edit-modal').classList.remove('open');
    this.editingItem = null;
  }

  async saveEdit() {
    if (!this.editingItem) return;
    const name = document.getElementById('edit-name').value;
    const path = document.getElementById('edit-path').value;
    const icon = document.getElementById('edit-icon').value;

    const props = { name, icon };
    if (this.editingItem.type === 'bookmark') props.url = path;
    else props.path = path;

    try {
      await fetch('/api/ui/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: this.editingItem.type, index: this.editingItem.index, properties: props }),
      });
      this.closeModal();
    } catch (err) {
      this.showToast('Failed to save changes');
    }
  }
}
window.app = new DashboardApp();
