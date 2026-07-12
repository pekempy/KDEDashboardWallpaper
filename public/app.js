class DashboardApp {
  constructor() {
    this.config = null;
    this.statusMap = new Map();
    this.activeTab = 'projects';
    this.activeCategory = 'all';
    this.searchQuery = '';
    this.isEditMode = false;
    this.sse = null;

    this.editingItem = null; // { type, id, index }
    
    this.init();
  }

  async init() {
    this.setupClock();
    this.bindEvents();
    
    await this.fetchConfig();
    this.fetchSystemStats();
    this.fetchStatuses();
    this.setupSSE();

    // Set background with cache bust
    document.getElementById('bg-layer').style.backgroundImage = `url('/background.jpg?t=${Date.now()}')`;

    // Intervals
    setInterval(() => this.fetchSystemStats(), 5000);
    setInterval(() => this.fetchStatuses(), 10000); // Polling backup for statuses
    
    lucide.createIcons();
  }

  setupClock() {
    const updateTime = () => {
      const now = new Date();
      document.getElementById('clock-display').innerText = now.toLocaleTimeString('en-US', {
        hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit'
      });
      document.getElementById('date-display').innerText = now.toLocaleDateString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric'
      });
    };
    updateTime();
    setInterval(updateTime, 1000);
  }

  bindEvents() {
    document.getElementById('btn-wallpaper').onclick = () => this.randomizeWallpaper();
    document.getElementById('btn-edit-mode').onclick = () => this.toggleEditMode();
    document.getElementById('global-search').oninput = (e) => {
      this.searchQuery = e.target.value.toLowerCase();
      this.renderProjects();
    };

    document.querySelectorAll('#main-tabs .tab').forEach(tab => {
      tab.onclick = (e) => {
        document.querySelectorAll('#main-tabs .tab').forEach(t => t.classList.remove('active'));
        e.currentTarget.classList.add('active');
        this.activeTab = e.currentTarget.dataset.tab;
        this.activeCategory = 'all';
        this.renderFilters();
        this.renderProjects();
      };
    });

    document.getElementById('btn-clear-logs').onclick = () => {
      document.getElementById('logs-output').innerHTML = '';
    };
  }

  setupSSE() {
    if (this.sse) this.sse.close();
    this.sse = new EventSource('/api/events');
    
    this.sse.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'service_status') {
          // Live status update for a service
          this.fetchStatuses(); // re-sync full state on service change
        } else if (msg.type === 'service_log') {
          this.appendLog(msg.data.log.text);
        } else if (msg.type === 'config_reload') {
          this.config = msg.data;
          this.fullRender();
          this.showToast('Configuration updated from server');
        } else if (msg.type === 'background_change') {
          document.getElementById('bg-layer').style.backgroundImage = `url('/background.jpg?t=${Date.now()}')`;
        }
      } catch (err) { }
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

  async fetchStatuses() {
    try {
      const res = await fetch('/api/projects/status');
      const list = await res.json();
      list.forEach(s => this.statusMap.set(s.id, s));
      this.updateProjectCardsStatus();
    } catch (err) { }
  }

  async fetchSystemStats() {
    try {
      const res = await fetch('/api/system/stats');
      const stats = await res.json();
      
      const formatBytes = (bytes) => (bytes / (1024 ** 3)).toFixed(1) + ' GB';
      
      // Update bars
      const cpuVal = Math.round(stats.cpu.load);
      document.getElementById('cpu-bar').style.width = cpuVal + '%';
      document.getElementById('cpu-val').innerText = cpuVal + '%';
      
      const ramPercent = Math.round(stats.memory.usedPercent);
      document.getElementById('ram-bar').style.width = ramPercent + '%';
      document.getElementById('ram-val').innerText = ramPercent + '%';

      // Disks
      let diskHtml = '';
      stats.disk.forEach(d => {
        diskHtml += `
          <div class="vital-item" style="margin-top: 8px;">
            <div class="vital-label" style="width: auto; font-size: 10px;">${d.mount}</div>
            <div class="progress-track" style="margin-left: 8px; height: 4px;"><div class="progress-fill" style="width: ${d.use}%; background: rgba(255,255,255,0.5);"></div></div>
            <div class="vital-val" style="width: 24px; font-size: 10px;">${Math.round(d.use)}%</div>
          </div>
        `;
      });
      document.getElementById('disk-vitals').innerHTML = diskHtml;

      // Uptime
      const s = stats.os.uptime;
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      document.getElementById('uptime-display').innerText = `${h}h ${m}m up`;
      
    } catch (err) { }
  }

  fullRender() {
    if (!this.config) return;
    
    // Theme
    if (this.config.ui) {
      if (this.config.ui.title) document.title = this.config.ui.title;
      if (this.config.ui.accent_color) {
        document.documentElement.style.setProperty('--accent-color', this.config.ui.accent_color);
      }
    }

    this.renderShortcuts(this.config.bookmarks, 'bookmarks-grid', 'bookmark', 'globe');
    this.renderShortcuts(this.config.quick_links, 'folders-grid', 'shortcut', 'folder');
    
    this.renderFilters();
    this.renderProjects();
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
      '🛠': 'wrench', '📊': 'bar-chart-2', '🦅': 'eye', '🔗': 'link', '☁️': 'cloud'
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
          <div class="edit-btn edit-only" onclick="event.stopPropagation(); app.openEditModal('${editType}', null, ${idx})">
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
      const url = this.config.bookmarks[idx].url;
      this.openExternal(url);
    } else {
      const path = this.config.quick_links[idx].path;
      this.executeCmd(`dolphin "${path}"`, '/home/glados');
    }
  }

  renderFilters() {
    const container = document.getElementById('category-filters');
    let html = `<button class="filter-btn ${this.activeCategory === 'all' ? 'active' : ''}" onclick="app.setCategory('all')">All</button>`;
    
    if (this.activeTab === 'projects') {
      (this.config.categories || []).forEach(c => {
        html += `<button class="filter-btn ${this.activeCategory === c.id ? 'active' : ''}" onclick="app.setCategory('${c.id}')">${c.name}</button>`;
      });
    } else {
      const stacks = this.config.dockerStacks?.stacks || [];
      stacks.forEach(s => {
        html += `<button class="filter-btn ${this.activeCategory === s ? 'active' : ''}" onclick="app.setCategory('${s}')">${s}</button>`;
      });
    }
    container.innerHTML = html;
  }

  setCategory(cat) {
    this.activeCategory = cat;
    this.renderFilters();
    this.renderProjects();
  }

  renderProjects() {
    const container = document.getElementById('projects-grid');
    const items = this.activeTab === 'projects' ? this.config.projects : this.config.docker;
    
    let html = '';
    const visible = (items || []).filter(p => !p.hidden).filter(p => {
      // Category filter
      if (this.activeCategory !== 'all') {
        if (this.activeTab === 'projects' && p.category !== this.activeCategory) return false;
        if (this.activeTab === 'docker') {
          const dockerName = p.status?.docker || p.id;
          const stack = this.config.dockerStacks?.mapping?.[dockerName] || this.config.dockerStacks?.mapping?.[p.id];
          if (stack !== this.activeCategory) return false;
        }
      }
      // Search
      if (this.searchQuery) {
        const q = this.searchQuery;
        return (p.name?.toLowerCase().includes(q) || p.description?.toLowerCase().includes(q) || p.path?.toLowerCase().includes(q));
      }
      return true;
    });

    visible.forEach(p => {
      html += `
        <div class="project-card" data-id="${p.id}">
          <div class="edit-btn edit-only" onclick="app.openEditModal('${this.activeTab === 'docker' ? 'docker' : 'project'}', '${p.id}', null)">
            <i data-lucide="edit-3"></i>
          </div>
          
          <div class="card-header">
            <div class="card-icon">${this.getIconHtml(p.icon, 'box')}</div>
            <div class="card-title">
              <h4>${p.name}</h4>
              <div class="card-path" title="${p.path || ''}">${p.path || p.description || ''}</div>
            </div>
          </div>
          <div class="card-desc">${p.description || ''}</div>
          
          <div class="card-status-row" id="status-row-${p.id}">
            <!-- Injected by fetchStatuses -->
          </div>
          
          <div class="card-actions">
            ${this.renderActions(p)}
          </div>
        </div>
      `;
    });
    
    container.innerHTML = html || `<div style="grid-column: 1/-1; text-align: center; color: var(--text-muted); margin-top: 40px;">No matches found.</div>`;
    lucide.createIcons();
    this.updateProjectCardsStatus();
  }

  renderActions(proj) {
    let html = '';
    // Custom actions
    (proj.actions || []).forEach(a => {
      const isDolphin = a.name.toLowerCase().includes('files');
      const icon = isDolphin ? 'folder' : 'play';
      const actionArgs = encodeURIComponent(JSON.stringify(a));
      html += `<button class="btn btn-ghost btn-sm" onclick="app.handleAction('${proj.id}', '${actionArgs}', '${proj.path}')"><i data-lucide="${icon}"></i> ${a.name}</button>`;
    });

    // Default docker actions
    if (proj.status?.docker) {
      html += `
        <button class="btn btn-primary btn-sm btn-docker-start" style="display:none;" onclick="app.dockerStart('${proj.status.docker}')"><i data-lucide="play"></i> Start</button>
        <button class="btn btn-ghost btn-sm btn-docker-stop" style="display:none; color: var(--danger);" onclick="app.dockerStop('${proj.status.docker}')"><i data-lucide="square"></i> Stop</button>
        <button class="btn btn-ghost btn-sm" onclick="app.dockerLogs('${proj.status.docker}')"><i data-lucide="terminal"></i> Logs</button>
      `;
    }

    // URLs
    const port = proj.status?.port;
    const internalUrl = port ? 'http://' + window.location.hostname + ':' + port : null;
    const externalUrl = (proj.status?.docker && this.config.caddyMappings) ? this.config.caddyMappings[proj.status.docker] : null;

    if (externalUrl) {
      html += `<button class="btn btn-ghost btn-sm" onclick="app.openExternal('${externalUrl}')"><i data-lucide="globe"></i> External</button>`;
    }
    if (internalUrl) {
      html += `<button class="btn btn-ghost btn-sm" onclick="app.openExternal('${internalUrl}')"><i data-lucide="home"></i> Local</button>`;
    }

    return html;
  }

  updateProjectCardsStatus() {
    this.statusMap.forEach((stat, id) => {
      const row = document.getElementById(`status-row-${id}`);
      if (!row) return;

      let html = '';
      if (stat.git?.isGit) {
        html += `<span class="status-pill"><i data-lucide="git-branch"></i> ${stat.git.branch}</span>`;
      }
      
      if (stat.docker) {
        const isOnline = stat.docker.running;
        html += `<span class="status-pill ${isOnline ? 'online' : 'offline'}"><i data-lucide="box"></i> ${stat.docker.status}</span>`;
        
        // Toggle start/stop buttons
        const card = row.closest('.project-card');
        const startBtn = card.querySelector('.btn-docker-start');
        const stopBtn = card.querySelector('.btn-docker-stop');
        if (startBtn && stopBtn) {
          startBtn.style.display = isOnline ? 'none' : 'inline-flex';
          stopBtn.style.display = isOnline ? 'inline-flex' : 'none';
        }
      }

      Object.entries(stat.ports || {}).forEach(([p, online]) => {
        html += `<span class="status-pill ${online ? 'online' : 'offline'}"><i data-lucide="radio"></i> :${p}</span>`;
      });

      row.innerHTML = html;
    });
    lucide.createIcons();
  }

  // Actions
  async handleAction(projectId, actionJsonString, path) {
    const action = JSON.parse(decodeURIComponent(actionJsonString));
    
    if (action.type === 'command') {
      this.executeCmd(action.cmd, path);
    } else if (action.type === 'stream') {
      this.openLogsDrawer(action.name);
      try {
        await fetch('/api/action/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId, actionName: action.name, cmd: action.cmd, path })
        });
      } catch (err) {}
    } else if (action.type === 'service') {
      // Start service and open logs
      this.openLogsDrawer(action.name);
      await fetch('/api/service/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, actionName: action.name })
      });
    } else if (action.type === 'url') {
      this.openExternal(action.url);
    }
  }

  async executeCmd(cmd, path) {
    try {
      const res = await fetch('/api/action/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cmd, path })
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
        body: JSON.stringify({ url })
      });
    } catch (err) { }
  }

  // Docker
  async dockerStart(container) {
    this.showToast(`Starting ${container}...`);
    await fetch('/api/docker/start', {
      method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({container})
    });
    setTimeout(() => this.fetchStatuses(), 1000);
  }
  async dockerStop(container) {
    this.showToast(`Stopping ${container}...`);
    await fetch('/api/docker/stop', {
      method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({container})
    });
    setTimeout(() => this.fetchStatuses(), 1000);
  }
  async dockerLogs(container) {
    this.openLogsDrawer(container);
    try {
      const res = await fetch(`/api/docker/logs/${container}`);
      const data = await res.json();
      if (data.success) {
        document.getElementById('logs-output').innerHTML = data.logs.replace(/\n/g, '<br>');
      }
    } catch (err) {}
  }

  // Utilities
  async randomizeWallpaper() {
    this.showToast('Loading random wallpaper...');
    try {
      await fetch('/api/background/randomize', { method: 'POST' });
    } catch (err) { }
  }

  launchKonsole() { this.executeCmd('konsole', '/home/glados'); }
  launchUpdate() { this.executeCmd('konsole -e topgrade', '/home/glados'); }

  openLogsDrawer(title) {
    document.getElementById('logs-title-text').innerText = `Logs: ${title}`;
    document.getElementById('logs-output').innerHTML = '';
    document.getElementById('logs-drawer').classList.add('open');
  }

  appendLog(text) {
    const out = document.getElementById('logs-output');
    const div = document.createElement('div');
    div.innerText = text;
    out.appendChild(div);
    out.scrollTop = out.scrollHeight;
  }

  showToast(msg) {
    const t = document.getElementById('toast');
    t.innerText = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 3000);
  }

  // Edit Mode Flow
  toggleEditMode() {
    this.isEditMode = !this.isEditMode;
    document.body.classList.toggle('edit-mode', this.isEditMode);
    document.getElementById('btn-edit-mode').style.color = this.isEditMode ? 'var(--accent-color)' : 'white';
    if(this.isEditMode) this.showToast('Edit Mode Enabled. Click edit icons on elements.');
  }

  addBookmark() { this.openEditModal('bookmark', null, this.config.bookmarks.length); }
  addFolder() { this.openEditModal('shortcut', null, this.config.quick_links.length); }

  openEditModal(type, id, index) {
    this.editingItem = { type, id, index };
    const modal = document.getElementById('edit-modal');
    
    // Default empty
    let initialName = '', initialPath = '', initialIcon = '';

    if (type === 'bookmark') {
      const b = this.config.bookmarks[index];
      if (b) { initialName = b.name; initialPath = b.url; initialIcon = b.icon; }
      document.getElementById('modal-title').innerText = b ? 'Edit Bookmark' : 'Add Bookmark';
    } else if (type === 'shortcut') {
      const s = this.config.quick_links[index];
      if (s) { initialName = s.name; initialPath = s.path; initialIcon = s.icon; }
      document.getElementById('modal-title').innerText = s ? 'Edit Folder' : 'Add Folder';
    } else if (type === 'project' || type === 'docker') {
      const list = type === 'project' ? this.config.projects : this.config.docker;
      const p = list.find(x => x.id === id);
      if (p) { initialName = p.name; initialPath = p.path; initialIcon = p.icon; }
      document.getElementById('modal-title').innerText = 'Edit ' + (type === 'docker' ? 'Container' : 'Project');
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
        body: JSON.stringify({
          type: this.editingItem.type,
          id: this.editingItem.id,
          index: this.editingItem.index,
          properties: props
        })
      });
      this.closeModal();
    } catch (err) {
      this.showToast('Failed to save changes');
    }
  }
}

// Boot
window.app = new DashboardApp();
