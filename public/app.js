console.log('app.js loaded');
class DashboardApp {
  constructor() {
    this.config = null;
    this.dockerContainers = [];
    this.recentMediaItems = [];
    this.lastRecentIds = new Set();
    this.nowPlayingItems = [];
    this.healthItems = [];
    this.downloadItems = [];
    this.collapsedWidgets = new Set(this.loadCollapsedWidgets());
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

  loadCollapsedWidgets() {
    try { return JSON.parse(localStorage.getItem('collapsedWidgets') || '[]'); } catch { return []; }
  }

  // Collapsible auto-hide widgets (Now Playing, Container Health, Downloads) -
  // collapsing one frees up column height for Recently Added, which resizes
  // itself on every fetch tick anyway, so just poke it after toggling.
  toggleWidgetCollapse(key) {
    if (this.collapsedWidgets.has(key)) this.collapsedWidgets.delete(key);
    else this.collapsedWidgets.add(key);
    localStorage.setItem('collapsedWidgets', JSON.stringify([...this.collapsedWidgets]));

    const targets = {
      nowplaying: ['widget-nowplaying', 'nowplaying-count', () => this.nowPlayingItems.length],
      health: ['widget-health', 'health-count', () => this.healthItems.length],
      downloads: ['widget-downloads', 'downloads-count', () => this.downloadItems.length],
    };
    const [widgetElId, countElId, count] = targets[key] || [];
    if (widgetElId) this.applyCollapseState(key, widgetElId, countElId, count());
    this.renderRecentGrid();
  }

  applyCollapseState(key, widgetElId, countElId, count) {
    const collapsed = this.collapsedWidgets.has(key);
    document.getElementById(widgetElId)?.classList.toggle('is-collapsed', collapsed);
    const countEl = document.getElementById(countElId);
    if (countEl) countEl.textContent = collapsed ? ` (${count})` : '';
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
      this.fetchNowPlaying();
      this.setupSSE();

      const bgLayer = document.getElementById('bg-layer');
      bgLayer.style.backgroundImage = `url('/background.jpg?t=${Date.now()}')`;

      // Multi-monitor: the wallpaper is one wide triple-panel image, and each
      // screen's window shows just its own slice of it, spread evenly across
      // screenId 1..monitorCount. Single monitor: no slicing needed - fall
      // back to the CSS default (background-size: cover; position: center),
      // which shows the actual center of the image instead of a slice of it.
      const monitorCount = this.displayConfig?.order?.length || 1;
      if (monitorCount > 1) {
        const pct = ((this.screenId - 1) / (monitorCount - 1)) * 100;
        bgLayer.style.setProperty('background-position', `${pct}% 50%`, 'important');
        bgLayer.style.setProperty('background-size', `${monitorCount * 100}% 100%`, 'important');
      } else {
        bgLayer.style.removeProperty('background-position');
        bgLayer.style.removeProperty('background-size');
      }

      setInterval(() => this.fetchSystemStats(), 5000);
      setInterval(() => this.fetchDockerContainers(), 15000);
      setInterval(() => this.fetchDownloads(), 5000);
      setInterval(() => this.fetchContainerHealth(), 5000);
      setInterval(() => this.fetchRecentMedia(), 60000);
      setInterval(() => this.fetchNowPlaying(), 5000);

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

    // Click-away-to-close for every modal - only when the click lands on the
    // overlay itself, not something inside the card.
    const modalClosers = { 'edit-modal': 'closeModal', 'logs-modal': 'closeLogsModal', 'stream-modal': 'closeStreamModal' };
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
      overlay.addEventListener('click', (e) => {
        if (e.target !== overlay) return;
        const closer = modalClosers[overlay.id];
        if (closer) this[closer]();
      });
    });

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
      this.downloadItems = items;
      if (!items.length) { widget.style.display = 'none'; this.renderRecentGrid(); return; }
      widget.style.display = this.shouldShowWidget('downloads') ? '' : 'none';
      el.innerHTML = items.map(d => `
        <div class="vital-item" style="margin-top: 6px;">
          <div class="vital-label mount-leaf" style="width: auto; font-size: 10.5px; max-width: 130px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${d.name}">${d.name}</div>
          <div class="progress-track" style="margin-left: 8px; height: 4px;"><div class="progress-fill" style="width: ${d.progress}%;"></div></div>
          <div class="vital-val" style="width: 28px; font-size: 10.5px;">${d.progress}%</div>
        </div>
      `).join('');
      this.applyCollapseState('downloads', 'widget-downloads', 'downloads-count', items.length);
      this.renderRecentGrid();
    } catch (err) {
      widget.style.display = 'none';
      this.activeDownloadsCount = 0;
      this.downloadItems = [];
      this.renderRecentGrid();
    }
  }

  async fetchContainerHealth() {
    const widget = document.getElementById('widget-health');
    const el = document.getElementById('health-list');
    try {
      const res = await fetch('/api/docker/unhealthy');
      const items = await res.json();
      this.healthItems = items;
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
      this.applyCollapseState('health', 'widget-health', 'health-count', items.length);
      this.renderRecentGrid();
    } catch (err) {
      widget.style.display = 'none';
      this.healthItems = [];
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

  // How many Recently Added tiles fit, and how tall each one gets. Now
  // Playing/Downloads/Container Health can each grow tall (more active
  // viewers/downloads/unhealthy containers = a taller sibling), so this
  // prefers shrinking the tile height to keep more items visible over just
  // dropping to fewer full-size rows - and only drops rows once tiles would
  // shrink past a legible floor.
  computeRecentLayout() {
    const column = document.querySelector('.widget-column-right');
    const siblingIds = ['widget-nowplaying', 'widget-downloads', 'widget-health'];
    const recentWidget = document.getElementById('widget-recent');
    const header = recentWidget.querySelector('.widget-header');
    const grid = document.getElementById('recent-grid');
    if (!column || !grid) return { maxItems: 9, rowHeight: null };

    const columnGap = 14;
    const siblings = siblingIds.map(id => document.getElementById(id)).filter(w => w && w.offsetHeight > 0);
    const consumedBySiblings = siblings.reduce((sum, w) => sum + w.offsetHeight + columnGap, 0);

    const widgetStyle = getComputedStyle(recentWidget);
    const chrome = header.offsetHeight
      + parseFloat(getComputedStyle(header).marginBottom)
      + parseFloat(widgetStyle.paddingTop) + parseFloat(widgetStyle.paddingBottom);

    const availableForGrid = column.clientHeight - consumedBySiblings - chrome;

    const gridGap = 8;
    const colWidth = (grid.clientWidth - gridGap * 2) / 3;
    if (colWidth <= 0) return { maxItems: 9, rowHeight: null };
    const naturalRowHeight = colWidth * 1.5;
    const minRowHeight = colWidth * 0.9;

    const fitsAtRows = (n) => (availableForGrid - (n - 1) * gridGap) / n;
    let rows = Math.max(1, Math.min(6, Math.floor((availableForGrid + gridGap) / (naturalRowHeight + gridGap))));
    while (rows > 1 && fitsAtRows(rows) < minRowHeight) rows--;
    const rowHeight = Math.min(naturalRowHeight, Math.max(minRowHeight, fitsAtRows(rows)));

    return { maxItems: rows * 3, rowHeight };
  }

  renderRecentGrid() {
    const el = document.getElementById('recent-grid');
    const items = this.recentMediaItems || [];
    const { maxItems, rowHeight } = this.computeRecentLayout();
    const shown = items.slice(0, maxItems);

    const shownKey = `${shown.map(m => m.id).join(',')}|${Math.round(rowHeight || 0)}`;
    if (shownKey === this.lastRenderedShownKey) return;
    this.lastRenderedShownKey = shownKey;

    const previouslySeen = this.lastRecentIds || new Set();
    const heightStyle = rowHeight ? `height:${Math.round(rowHeight)}px;` : '';

    el.innerHTML = shown.map((m, idx) => {
      const isNew = !previouslySeen.has(m.id);
      const style = `${heightStyle}${isNew ? `animation-delay: ${idx * 45}ms;` : ''}`;
      return `
      <div class="recent-item source-${m.source}${isNew ? ' is-new' : ''}" style="${style}" title="${m.title}" data-idx="${idx}">
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

  async fetchNowPlaying() {
    const widget = document.getElementById('widget-nowplaying');
    const el = document.getElementById('nowplaying-list');
    try {
      const res = await fetch('/api/media/nowplaying');
      const items = await res.json();
      this.nowPlayingItems = items;
      if (!items.length) { widget.style.display = 'none'; this.renderRecentGrid(); return; }
      widget.style.display = this.shouldShowWidget('now_playing') ? '' : 'none';

      el.innerHTML = items.map((s, idx) => `
        <div class="nowplaying-item${s.transcoding ? ' is-transcode' : ''}" data-idx="${idx}" title="${s.title}${s.subtitle ? ' · ' + s.subtitle : ''}">
          <div class="np-poster-wrap">
            ${s.posterUrl ? `<img class="np-poster" src="${s.posterUrl}" alt="" loading="lazy">` : `<div class="np-poster np-poster-empty"></div>`}
            ${s.user.avatarUrl ? `<img class="np-avatar" src="${s.user.avatarUrl}" alt="">` : `<div class="np-avatar np-avatar-empty">${(s.user.name || '?').charAt(0).toUpperCase()}</div>`}
          </div>
          <div class="np-info">
            <div class="np-title">${s.user.name}</div>
            <div class="np-subtitle">${s.title}${s.subtitle ? ' · ' + s.subtitle : ''}</div>
            <div class="progress-track np-progress"><div class="progress-fill" style="width: ${s.progressPercent}%;"></div></div>
          </div>
          <span class="np-badge ${s.transcoding ? 'is-transcode' : 'is-direct'}" title="${s.transcoding ? 'Transcoding' : 'Direct Play'}">
            <i data-lucide="${s.transcoding ? 'cpu' : 'zap'}"></i>
          </span>
        </div>
      `).join('');

      el.querySelectorAll('.nowplaying-item').forEach(node => {
        node.onclick = () => this.openStreamModal(items[+node.dataset.idx]);
      });
      lucide.createIcons();
      this.applyCollapseState('nowplaying', 'widget-nowplaying', 'nowplaying-count', items.length);
      this.renderRecentGrid();
    } catch (err) {
      widget.style.display = 'none';
      this.nowPlayingItems = [];
      this.renderRecentGrid();
    }
  }

  openStreamModal(s) {
    const posterEl = document.getElementById('stream-modal-poster');
    posterEl.src = s.posterUrl || '';
    posterEl.style.display = s.posterUrl ? '' : 'none';
    const avatarEl = document.getElementById('stream-modal-avatar');
    avatarEl.src = s.user.avatarUrl || '';
    avatarEl.style.display = s.user.avatarUrl ? '' : 'none';

    document.getElementById('stream-modal-title').innerText = s.title;
    document.getElementById('stream-modal-subtitle').innerText = [s.subtitle, s.user.name].filter(Boolean).join(' · ');

    document.getElementById('stream-modal-progress-fill').style.width = `${s.progressPercent}%`;
    const fmtTime = (iso) => iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null;
    document.getElementById('stream-modal-started').innerText = s.startedAt ? `Started ${fmtTime(s.startedAt)}` : '';
    document.getElementById('stream-modal-percent').innerText = `${s.progressPercent}%`;
    document.getElementById('stream-modal-ends').innerText = s.state === 'paused'
      ? 'Paused' : (s.endsAt ? `Ends ~${fmtTime(s.endsAt)}` : '');

    const reasonBox = document.getElementById('stream-modal-reason');
    if (s.transcoding && s.details.reasons?.length) {
      document.getElementById('stream-modal-reason-text').innerText = s.details.reasons.join(' · ');
      reasonBox.style.display = '';
    } else {
      reasonBox.style.display = 'none';
    }

    const stats = [
      ['Source', s.source === 'jellyfin' ? 'Jellyfin' : 'Plex'],
      ['Status', s.state === 'paused' ? 'Paused' : 'Playing'],
      ['Play Method', s.playMethod],
      ['Resolution', s.quality.resolution || '—'],
      ['Device', [s.client, s.device].filter(Boolean).join(' · ') || '—', true],
      ['Video', [s.details.videoDecision, s.quality.videoCodec].filter(Boolean).join(' · ')],
      ['Audio', [s.details.audioDecision, s.quality.audioCodec].filter(Boolean).join(' · ')],
      ['Container', s.quality.container || '—'],
      ['Bitrate', s.quality.bitrate ? `${s.quality.bitrate} kbps` : '—'],
    ];

    const escapeHtml = (str) => String(str).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    document.getElementById('stream-modal-stats').innerHTML = stats.map(([label, value, wide]) => `
      <div class="stream-stat${wide ? ' stream-stat-wide' : ''}">
        <div class="stream-stat-label">${escapeHtml(label)}</div>
        <div class="stream-stat-value">${escapeHtml(value)}</div>
      </div>
    `).join('');

    document.getElementById('stream-modal').classList.add('open');
  }

  closeStreamModal() {
    document.getElementById('stream-modal').classList.remove('open');
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
        'widget-nowplaying': 'now_playing',
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
