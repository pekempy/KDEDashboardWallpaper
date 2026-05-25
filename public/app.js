// Frontend App logic - GLaDOS Dashboard

let dashboardConfig = null;
let projectStatuses = [];
let activeCategory = 'all';
let searchFilter = '';
let activeLogService = null; // { projectId, actionName }
let activeDockerLogInterval = null;
let activeTab = 'projects';
let eventSource = null;
let isEditMode = false;
let isCompactMode = localStorage.getItem('isCompactMode') === 'true';

// Helpers
function getIconMarkup(iconStr, defaultIcon = 'box') {
  if (!iconStr) {
    return `<i data-lucide="${defaultIcon}"></i>`;
  }
  iconStr = iconStr.trim();
  if (iconStr.startsWith('<')) {
    return iconStr;
  }

  // Image URL support
  if (iconStr.startsWith('http') || /\.(png|jpg|jpeg|svg|webp)$/i.test(iconStr)) {
    return `<img src="${iconStr}" alt="icon" style="width:20px;height:20px;object-fit:contain;border-radius:3px;" onerror="this.style.display='none'">`;
  }

  const emojiMap = {
    '🚀': 'rocket',
    '🐳': 'box',
    '🤖': 'bot',
    '🐚': 'terminal',
    '🌐': 'globe',
    '📂': 'folder-open',
    '📁': 'folder',
    '📥': 'download',
    '🎬': 'film',
    '🎭': 'theater',
    '📖': 'book',
    '📚': 'book-open',
    '🎶': 'music',
    '🏺': 'package',
    '🛠️': 'wrench',
    '🛠': 'wrench',
    '📊': 'bar-chart-2',
    '🦅': 'eye',
    '🔗': 'link'
  };

  if (emojiMap[iconStr]) {
    return `<i data-lucide="${emojiMap[iconStr]}"></i>`;
  }

  if (/^[a-z0-9-]+$/i.test(iconStr)) {
    return `<i data-lucide="${iconStr}"></i>`;
  }

  for (const [emoji, lucideName] of Object.entries(emojiMap)) {
    if (iconStr.includes(emoji)) {
      return `<i data-lucide="${lucideName}"></i>`;
    }
  }

  // Fallback: render as text (emoji)
  return `<span style="font-size:16px;line-height:1;">${iconStr}</span>`;
}

function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : null;
}

function showToast(message) {
  const toast = document.getElementById('notification-toast');
  const msgEl = toast.querySelector('.toast-message');
  msgEl.textContent = message;
  toast.classList.add('active');
  setTimeout(() => {
    toast.classList.remove('active');
  }, 4000);
}

// Background Wallpaper helpers
function updateBackground(cacheBust = true) {
  const bg = document.getElementById('bg-image-container');
  if (!bg) return;
  const time = cacheBust ? new Date().getTime() : 0;
  bg.style.backgroundImage = `url('/background.jpg?t=${time}')`;
}

async function randomizeWallpaper() {
  const btn = document.getElementById('btn-random-bg');
  if (btn) {
    btn.disabled = true;
    btn.style.opacity = 0.6;
  }
  showToast('Fetching random background via rclone...');
  try {
    const res = await fetch('/api/background/randomize', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast(`New background loaded: ${data.filename}`);
    } else {
      showToast(`Rclone download failed: ${data.error}`);
    }
  } catch (err) {
    showToast(`Error randomizing background: ${err.message}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.style.opacity = 1;
    }
  }
}


// Fetch dashboard config
async function fetchConfig() {
  try {
    const res = await fetch('/api/config');
    dashboardConfig = await res.json();
    applyUITheme(dashboardConfig);
    refreshCategories();
    renderQuickLinks(dashboardConfig.quick_links);
    renderBookmarks(dashboardConfig.bookmarks);
    renderProjects();
    
    applyTabOrder();
    applySidebarWidgetsOrder();
    applyEditModeLayoutStates();
  } catch (err) {
    console.error('Error fetching config:', err);
    showToast('Failed to load dashboard configuration');
  }
}

// Fetch statuses
async function fetchStatuses() {
  try {
    const res = await fetch('/api/projects/status');
    projectStatuses = await res.json();
    updateProjectCardsStatus();
  } catch (err) {
    console.error('Error fetching statuses:', err);
  }
}

// Fetch system stats
async function fetchSystemStats() {
  try {
    const res = await fetch('/api/system/stats');
    const stats = await res.json();
    updateSystemMonitor(stats);
  } catch (err) {
    console.error('Error fetching system stats:', err);
  }
}

// Apply theme settings dynamically from yaml config
function applyUITheme(cfg) {
  if (!cfg.ui) return;
  
  if (cfg.ui.title) {
    const titleEl = document.getElementById('dashboard-title');
    titleEl.textContent = cfg.ui.title;
    document.title = cfg.ui.title;
    if (isEditUiMode) {
      titleEl.classList.add('edit-ui-editable');
      titleEl.onclick = handleTitleEdit;
    } else {
      titleEl.classList.remove('edit-ui-editable');
      titleEl.onclick = null;
    }
  }
  
  if (cfg.ui.accent_color) {
    document.documentElement.style.setProperty('--accent-color', cfg.ui.accent_color);
    const rgb = hexToRgb(cfg.ui.accent_color);
    if (rgb) {
      document.documentElement.style.setProperty('--accent-rgb', `${rgb.r}, ${rgb.g}, ${rgb.b}`);
    }
  }
  
  if (cfg.ui.background_gradient) {
    document.documentElement.style.setProperty('--bg-primary', 'transparent');
    document.body.style.background = cfg.ui.background_gradient;
    document.body.style.backgroundAttachment = 'fixed';
  }
}

// Render categories tabs
function renderCategories(categories) {
  const container = document.getElementById('categories-tabs-container');
  container.innerHTML = '';
  
  // Recreate the "All" button dynamically
  const allBtn = document.createElement('button');
  allBtn.className = `tab-btn ${activeCategory === 'all' ? 'active' : ''}`;
  allBtn.setAttribute('data-category', 'all');
  
  const isDocker = activeTab === 'docker';
  allBtn.innerHTML = `
    <i data-lucide="${isDocker ? 'box' : 'grid'}"></i>
    <span>${isDocker ? 'All Containers' : 'All Projects'}</span>
  `;
  
  allBtn.addEventListener('click', (e) => {
    if (isEditMode) {
      e.preventDefault();
      return;
    }
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    allBtn.classList.add('active');
    activeCategory = 'all';
    renderProjects();
  });
  
  if (isEditMode) {
    allBtn.setAttribute('draggable', 'true');
    makeDraggable(allBtn);
  }
  
  container.appendChild(allBtn);
  
  categories.forEach(cat => {
    const btn = document.createElement('button');
    btn.className = `tab-btn ${activeCategory === cat.id ? 'active' : ''}`;
    btn.setAttribute('data-category', cat.id);
    btn.innerHTML = `
      <span class="category-icon-wrapper">${getIconMarkup(cat.icon, 'folder')}</span>
      <span>${cat.name}</span>
    `;
    if (isEditUiMode) {
      btn.classList.add('edit-ui-editable');
      const iconWrapper = btn.querySelector('.category-icon-wrapper');
      if (iconWrapper) {
        iconWrapper.classList.add('edit-ui-icon-editable');
        iconWrapper.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          showIconPicker(iconWrapper, async (newIcon) => {
            await updateUiElement('category', cat.id, null, {
              name: cat.name,
              icon: newIcon
            });
          });
        });
      }
      btn.addEventListener('click', (e) => {
        if (e.target.closest('.category-icon-wrapper')) return;
        handleCategoryEdit(e, cat.id);
      });
    } else {
      btn.addEventListener('click', (e) => {
        if (isEditMode) {
          e.preventDefault();
          return;
        }
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeCategory = cat.id;
        renderProjects();
      });
    }
    
    if (isEditMode) {
      btn.setAttribute('draggable', 'true');
      makeDraggable(btn);
    }
    
    container.appendChild(btn);
  });
  
  lucide.createIcons();
}

// Refresh categories list dynamically based on active tab
function refreshCategories() {
  if (!dashboardConfig) return;
  if (activeTab === 'projects') {
    renderCategories(dashboardConfig.categories || []);
  } else if (activeTab === 'docker') {
    const dockerStacks = dashboardConfig.dockerStacks?.stacks || [];
    const stackCats = dockerStacks.map(stack => ({
      id: stack,
      name: stack,
      icon: '🐳'
    }));
    renderCategories(stackCats);
  }
}

// Render folder shortcuts
// Render folder shortcuts
function renderQuickLinks(links) {
  const container = document.getElementById('quick-links-container');
  container.innerHTML = '';
  
  const visibleLinks = links || [];
  
  if (visibleLinks.length === 0) {
    container.innerHTML = '<span class="text-muted" style="grid-column: 1/-1; text-align: center; font-size: 13px;">No folders</span>';
    return;
  }
  
  visibleLinks.forEach((link, idx) => {
    const a = document.createElement('a');
    a.href = '#';
    a.className = 'quick-link-item';
    a.setAttribute('data-name', link.name);
    a.innerHTML = `
      <span class="quick-link-icon">${getIconMarkup(link.icon, 'folder')}</span>
      <span>${link.name}</span>
    `;
    if (isEditUiMode) {
      a.classList.add('edit-ui-editable');
      const iconWrapper = a.querySelector('.quick-link-icon');
      if (iconWrapper) {
        iconWrapper.classList.add('edit-ui-icon-editable');
        iconWrapper.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          showIconPicker(iconWrapper, async (newIcon) => {
            await updateUiElement('shortcut', null, idx, {
              name: link.name,
              icon: newIcon
            });
          });
        });
      }
      a.addEventListener('click', (e) => {
        if (e.target.closest('.quick-link-icon')) return;
        handleShortcutEdit(e, idx);
      });
    } else {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        if (isEditMode) return;
        openFolderShortcut(link.path);
      });
    }
    
    if (isEditMode) {
      a.setAttribute('draggable', 'true');
      makeDraggable(a);
    }
    
    container.appendChild(a);
  });
  lucide.createIcons();
}

// Render bookmarks list
function renderBookmarks(bookmarks) {
  const container = document.getElementById('bookmarks-container');
  container.innerHTML = '';
  
  const visibleBookmarks = bookmarks || [];
  
  if (visibleBookmarks.length === 0) {
    container.innerHTML = '<span class="text-muted" style="grid-column: 1/-1; text-align: center; font-size: 13px;">No bookmarks</span>';
    return;
  }
  
  visibleBookmarks.forEach((bm, idx) => {
    const a = document.createElement('a');
    a.href = '#';
    a.className = 'quick-link-item';
    a.setAttribute('data-name', bm.name);
    a.innerHTML = `
      <span class="quick-link-icon">${getIconMarkup(bm.icon, 'link')}</span>
      <span>${bm.name}</span>
    `;
    if (isEditUiMode) {
      a.classList.add('edit-ui-editable');
      const iconWrapper = a.querySelector('.quick-link-icon');
      if (iconWrapper) {
        iconWrapper.classList.add('edit-ui-icon-editable');
        iconWrapper.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          showIconPicker(iconWrapper, async (newIcon) => {
            await updateUiElement('bookmark', null, idx, {
              name: bm.name,
              icon: newIcon
            });
          });
        });
      }
      a.addEventListener('click', (e) => {
        if (e.target.closest('.quick-link-icon')) return;
        handleBookmarkEdit(e, idx);
      });
    } else {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        if (!isEditMode) {
          triggerHostOpenUrl(bm.url);
        }
      });
    }
    
    if (isEditMode) {
      a.setAttribute('draggable', 'true');
      makeDraggable(a);
    }
    
    container.appendChild(a);
  });
  lucide.createIcons();
}

// Invoke dolphin on target directory
async function openFolderShortcut(path) {
  showToast(`Opening folder: ${path}...`);
  try {
    const res = await fetch('/api/action/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cmd: `dolphin "${path}"`,
        path: '/home/glados'
      })
    });
    const data = await res.json();
    if (!data.success) {
      showToast(`Failed to open: ${data.error}`);
    }
  } catch (err) {
    showToast(`Error: ${err.message}`);
  }
}

// Render projects grid
function renderProjects() {
  const container = document.getElementById('projects-grid-container');
  container.innerHTML = '';
  
  if (!dashboardConfig) return;
  
  const projectsSource = (activeTab === 'projects' ? dashboardConfig.projects : dashboardConfig.docker) || [];
  const visibleProjects = projectsSource.filter(proj => !proj.hidden);
  
  const filtered = visibleProjects.filter(proj => {
    // Category/Stack filter
    if (activeCategory !== 'all') {
      if (activeTab === 'projects') {
        if (proj.category !== activeCategory) return false;
      } else if (activeTab === 'docker') {
        const dockerName = proj.status?.docker || proj.id;
        const stack = dashboardConfig.dockerStacks?.mapping?.[dockerName] || dashboardConfig.dockerStacks?.mapping?.[proj.id];
        if (stack !== activeCategory) return false;
      }
    }
    
    // Search filter
    if (searchFilter) {
      const query = searchFilter.toLowerCase();
      return (
        proj.name.toLowerCase().includes(query) ||
        proj.description.toLowerCase().includes(query) ||
        proj.path.toLowerCase().includes(query) ||
        (proj.category && proj.category.toLowerCase().includes(query))
      );
    }
    
    return true;
  });
  
  if (filtered.length === 0) {
    container.innerHTML = `
      <div style="grid-column: 1/-1; text-align: center; padding: 40px; color: var(--text-muted);">
        <i data-lucide="folder-search" style="width: 48px; height: 48px; margin-bottom: 12px; stroke-width: 1.5;"></i>
        <p>No projects match current filters</p>
      </div>
    `;
    lucide.createIcons();
    return;
  }
  
  filtered.forEach(proj => {
    const card = document.createElement('div');
    card.className = 'project-card';
    card.setAttribute('data-id', proj.id);
    
    // Assign randomized animation duration and delay for the glowing path borders
    const duration = (15 + Math.random() * 15).toFixed(1) + 's';
    const delay = (-Math.random() * 20).toFixed(1) + 's';
    card.style.animationDuration = duration;
    card.style.animationDelay = delay;
    
    if (isEditMode) {
      card.setAttribute('draggable', 'true');
      makeDraggable(card);
    }
    
    // Check status container
    const gitStatusHTML = proj.status?.git ? `
      <span class="status-indicator git-status" id="git-status-${proj.id}" data-tooltip="Git Branch: checking...">
        <i data-lucide="git-branch"></i>
      </span>
    ` : '';
    
    const portStatusHTML = proj.status?.port ? `
      <span class="status-indicator port-status" id="port-status-${proj.id}-${proj.status.port}" data-tooltip="Port ${proj.status.port}: checking...">
        <i data-lucide="radio"></i>
        <span class="port-text" style="font-size: 11px; margin-left: 2px;">${proj.status.port}</span>
      </span>
    ` : '';
    
    const dockerStatusHTML = proj.status?.docker ? `
      <span class="status-indicator docker-status" id="docker-status-${proj.id}" data-tooltip="Docker: checking...">
        <i data-lucide="box"></i>
      </span>
    ` : '';
    
    // Service pills
    let servicesPillsHTML = '';
    proj.actions.forEach(action => {
      if (action.type === 'service') {
        servicesPillsHTML += `
          <span class="service-pill stopped" id="service-pill-${proj.id}-${action.name.replace(/\s+/g, '_')}">
            <span class="pulse-dot" style="background-color: var(--text-muted)"></span>
            <span>${action.name}</span>
          </span>
        `;
      }
    });

    // Action buttons list
    let actionsHTML = '';
    
    // Inject Docker control actions if configured
    if (proj.status?.docker) {
      actionsHTML += `
        <div class="docker-action-group" style="display: contents;" id="docker-actions-${proj.id}">
          <button class="btn btn-primary action-btn btn-docker-start" style="display: none;" onclick="startDockerContainer('${proj.id}', '${proj.status.docker}')">
            <i data-lucide="play"></i>
            <span>Start Container</span>
          </button>
          <button class="btn btn-danger action-btn btn-docker-stop" style="display: none;" onclick="stopDockerContainer('${proj.id}', '${proj.status.docker}')">
            <i data-lucide="square"></i>
            <span>Stop Container</span>
          </button>
          <button class="btn btn-secondary action-btn btn-docker-logs" onclick="openDockerLogsDrawer('${proj.id}', '${proj.status.docker}')">
            <i data-lucide="terminal"></i>
            <span>Logs</span>
          </button>
        </div>
      `;
    }
    
    // Dynamically inject Open buttons
    const dockerName = proj.status?.docker;
    const externalUrl = (dockerName && dashboardConfig?.caddyMappings) ? dashboardConfig.caddyMappings[dockerName] : null;
    const portVal = proj.status?.port;
    const internalUrl = portVal ? `http://${window.location.hostname}:${portVal}` : null;
    
    if (externalUrl && internalUrl) {
      actionsHTML += `
        <button class="btn btn-secondary action-btn open-link-btn" onclick="triggerHostOpenUrl('${internalUrl}')">
          <i data-lucide="home"></i>
          <span>Open Internal</span>
        </button>
        <button class="btn btn-secondary action-btn open-link-btn" onclick="triggerHostOpenUrl('${externalUrl}')">
          <i data-lucide="globe"></i>
          <span>Open External</span>
        </button>
      `;
    } else if (externalUrl) {
      actionsHTML += `
        <button class="btn btn-secondary action-btn open-link-btn" onclick="triggerHostOpenUrl('${externalUrl}')">
          <i data-lucide="globe"></i>
          <span>Open External</span>
        </button>
      `;
    } else if (internalUrl) {
      actionsHTML += `
        <button class="btn btn-secondary action-btn open-link-btn" onclick="triggerHostOpenUrl('${internalUrl}')">
          <i data-lucide="external-link"></i>
          <span>Open Link</span>
        </button>
      `;
    }
    
    proj.actions.forEach((action, index) => {
      if (action.type === 'command') {
        actionsHTML += `
          <button class="btn btn-secondary action-btn" onclick="runCommandAction('${proj.id}', ${index})">
            <i data-lucide="play-circle"></i>
            <span>${action.name}</span>
          </button>
        `;
      } else if (action.type === 'stream') {
        actionsHTML += `
          <button class="btn btn-secondary action-btn" onclick="runStreamAction('${proj.id}', ${index})">
            <i data-lucide="terminal"></i>
            <span>${action.name}</span>
          </button>
        `;
      } else if (action.type === 'service') {
        const actionSlug = action.name.replace(/\s+/g, '_');
        actionsHTML += `
          <div class="service-action-group" style="display: contents;" id="service-action-${proj.id}-${actionSlug}">
            <button class="btn btn-primary action-btn btn-start" onclick="startServiceAction('${proj.id}', '${action.name}')">
              <i data-lucide="play"></i>
              <span>Start</span>
            </button>
            <button class="btn btn-danger action-btn btn-stop" style="display: none;" onclick="stopServiceAction('${proj.id}', '${action.name}')">
              <i data-lucide="square"></i>
              <span>Stop</span>
            </button>
            <button class="btn btn-secondary action-btn btn-logs" onclick="openLogsDrawer('${proj.id}', '${action.name}')">
              <i data-lucide="terminal"></i>
              <span>Logs</span>
            </button>
          </div>
        `;
      } else if (action.type === 'url') {
        actionsHTML += `
          <button class="btn btn-secondary action-btn" onclick="openUrlAction('${proj.id}', ${index})">
            <i data-lucide="external-link"></i>
            <span>${action.name}</span>
          </button>
        `;
      }
    });
    
    const hideBtn = isEditMode ? `
      <button class="btn-hide-card" title="Hide permanently" onclick="hideProjectCard(event, '${proj.id}', ${activeTab === 'docker'})">
        <i data-lucide="eye-off"></i>
      </button>` : '';
    
    const editUiBtn = isEditUiMode ? `
      <button class="btn-hide-card edit-ui-active-btn" title="Edit details" onclick="handleCardEdit(event, '${activeTab === 'docker' ? 'docker' : 'project'}', '${proj.id}')" style="top: 8px; right: 8px; background: rgba(212, 175, 55, 0.2); border: 1px solid var(--accent-color); color: var(--accent-color);">
        <i data-lucide="edit-3" style="width: 14px; height: 14px;"></i>
      </button>` : '';
    
    card.innerHTML = `
      ${hideBtn}
      ${editUiBtn}
      <div>
        <div class="project-card-header">
          <div class="project-title-row">
            <div class="project-icon-box">${getIconMarkup(proj.icon, 'rocket')}</div>
            <div class="project-meta">
              <h2 class="project-name">${proj.name}</h2>
              <span class="project-path" title="${proj.path}">${proj.path}</span>
            </div>
          </div>
        </div>
        
        <p class="project-description" style="margin-top: 12px;">${proj.description || 'No description provided.'}</p>
        
        <div class="project-status-row">
          ${gitStatusHTML}
          ${dockerStatusHTML}
          ${portStatusHTML}
          ${servicesPillsHTML}
        </div>
      </div>
      
      <div class="project-actions-list">
        ${actionsHTML}
      </div>
    `;
    
    container.appendChild(card);
    
    if (isEditUiMode) {
      const iconBox = card.querySelector('.project-icon-box');
      if (iconBox) {
        iconBox.classList.add('edit-ui-icon-editable');
        iconBox.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          showIconPicker(iconBox, async (newIcon) => {
            const type = activeTab === 'docker' ? 'docker' : 'project';
            await updateUiElement(type, proj.id, null, {
              name: proj.name,
              icon: newIcon,
              description: proj.description
            });
          });
        });
      }
    }
  });
  
  lucide.createIcons();
  
  // Instantly apply current cached statuses if available
  updateProjectCardsStatus();
}

// Update card status styles
function updateProjectCardsStatus() {
  projectStatuses.forEach(stat => {
    const card = document.querySelector(`.project-card[data-id="${stat.id}"]`);
    if (!card) return;
    
    // Git badge update
    if (stat.git) {
      const gitBadge = card.querySelector(`.git-status`);
      if (gitBadge) {
        if (stat.git.isGit) {
          gitBadge.style.display = 'inline-flex';
          gitBadge.className = 'status-indicator git-status ' + (stat.git.isDirty ? 'git-dirty' : 'git-clean');
          gitBadge.setAttribute('data-tooltip', `Git Branch: ${stat.git.branch}${stat.git.isDirty ? ` (dirty, *${stat.git.dirtyCount} files modified)` : ' (clean)'}`);
        } else {
          gitBadge.style.display = 'none';
        }
      }
    }
    
    // Port badges update
    Object.keys(stat.ports).forEach(port => {
      const portBadge = card.querySelector(`.port-status[id*="${port}"]`);
      if (portBadge) {
        const isOpen = stat.ports[port];
        portBadge.className = `status-indicator port-status ${isOpen ? 'port-online' : 'port-offline'}`;
        portBadge.setAttribute('data-tooltip', `Port ${port}: ${isOpen ? 'Online' : 'Offline'}`);
      }
    });

    // Docker status update
    if (stat.docker) {
      const dockerBadge = card.querySelector(`.docker-status`);
      if (dockerBadge) {
        if (stat.docker.running) {
          dockerBadge.className = 'status-indicator docker-status docker-running';
          dockerBadge.setAttribute('data-tooltip', `Docker: ${stat.docker.status} (running)`);
        } else {
          dockerBadge.className = 'status-indicator docker-status docker-stopped';
          dockerBadge.setAttribute('data-tooltip', `Docker: ${stat.docker.status} (stopped)`);
        }
      }
      
      const dockerActions = card.querySelector(`#docker-actions-${stat.id}`);
      if (dockerActions) {
        const btnStart = dockerActions.querySelector('.btn-docker-start');
        const btnStop = dockerActions.querySelector('.btn-docker-stop');
        if (stat.docker.running) {
          if (btnStart) btnStart.style.display = 'none';
          if (btnStop) btnStop.style.display = 'inline-flex';
        } else {
          if (btnStart) btnStart.style.display = 'inline-flex';
          if (btnStop) btnStop.style.display = 'none';
        }
      }
    }
    
    // Services update (play/stop toggles & pills)
    Object.keys(stat.services).forEach(actionName => {
      const actionSlug = actionName.replace(/\s+/g, '_');
      const servicePill = card.querySelector(`[id="service-pill-${stat.id}-${actionSlug}"]`);
      const serviceActionGroup = card.querySelector(`[id="service-action-${stat.id}-${actionSlug}"]`);
      const svcInfo = stat.services[actionName];
      const isRunning = svcInfo && svcInfo.status === 'running';
      
      if (servicePill) {
        const pulse = servicePill.querySelector('.pulse-dot');
        if (isRunning) {
          servicePill.className = 'service-pill running';
          pulse.style.backgroundColor = 'var(--success)';
        } else {
          servicePill.className = 'service-pill stopped';
          pulse.style.backgroundColor = 'var(--text-muted)';
        }
      }
      
      if (serviceActionGroup) {
        const btnStart = serviceActionGroup.querySelector('.btn-start');
        const btnStop = serviceActionGroup.querySelector('.btn-stop');
        
        if (isRunning) {
          if (btnStart) btnStart.style.display = 'none';
          if (btnStop) btnStop.style.display = 'inline-flex';
        } else {
          if (btnStart) btnStart.style.display = 'inline-flex';
          if (btnStop) btnStop.style.display = 'none';
        }
      }
    });
  });
}

// Action Trigger Handlers

// Run CLI actions
async function runCommandAction(projectId, actionIndex) {
  const project = dashboardConfig.projects.find(p => p.id === projectId);
  const action = project.actions[actionIndex];
  
  showToast(`Running: ${action.name}...`);
  
  try {
    const res = await fetch('/api/action/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cmd: action.cmd,
        path: project.path
      })
    });
    
    const data = await res.json();
    if (data.success) {
      showToast(`Success: ${action.name}`);
      console.log(`[Action: ${action.name}] Executed successfully.\n$ ${action.cmd}\n${data.stdout || ''}`);
      if (data.stderr) console.warn(data.stderr);
      
      const termOutput = document.getElementById('terminal-output');
      if (termOutput) {
        termOutput.innerHTML = `
          <span class="system">[Action: ${action.name}] Executed successfully.</span>
          <span>$ ${action.cmd}</span>
          <span>${data.stdout || ''}</span>
          ${data.stderr ? `<span class="error">${data.stderr}</span>` : ''}
        `;
        termOutput.scrollTop = termOutput.scrollHeight;
      }
    } else {
      showToast(`Failed: ${action.name}`);
      console.error(`[Action: ${action.name}] Execution error.\n$ ${action.cmd}\n${data.error || data.stderr}`);
      
      const termOutput = document.getElementById('terminal-output');
      if (termOutput) {
        termOutput.innerHTML = `
          <span class="error">[Action: ${action.name}] Execution error.</span>
          <span>$ ${action.cmd}</span>
          <span class="error">${data.error || data.stderr}</span>
        `;
        termOutput.scrollTop = termOutput.scrollHeight;
      }
    }
  } catch (err) {
    console.error(`Error running action:`, err);
    showToast(`Error running action: ${err.message}`);
  }
  
  fetchStatuses();
}

// Run a one-shot command with output streamed to the logs drawer
async function runStreamAction(projectId, actionIndex) {
  const project = dashboardConfig.projects.find(p => p.id === projectId);
  const action = project.actions[actionIndex];

  // Open the drawer first so the user sees output as it arrives
  activeLogService = { projectId, actionName: action.name };
  document.getElementById('drawer-title').textContent = `${action.name} Console`;
  document.getElementById('drawer-subtitle').textContent = `${project.name} (${project.path})`;

  const logWindow = document.getElementById('service-log-window');
  logWindow.innerHTML = '<span class="text-muted">Starting ' + action.name + '...</span>';

  document.getElementById('logs-drawer').classList.add('active');
  document.getElementById('logs-drawer-overlay').classList.add('active');

  showToast(`Running: ${action.name}...`);

  try {
    const res = await fetch('/api/action/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId,
        actionName: action.name,
        cmd: action.cmd,
        path: project.path
      })
    });
    const data = await res.json();
    if (!data.success) {
      logWindow.innerHTML = `<span class="error">Failed to start: ${data.error || 'unknown error'}</span>`;
    } else {
      // Clear placeholder; live lines arrive via SSE
      logWindow.innerHTML = '';
    }
  } catch (err) {
    logWindow.innerHTML = `<span class="error">Error: ${err.message}</span>`;
  }
}

// Start background service
async function startServiceAction(projectId, actionName) {
  showToast(`Starting service: ${actionName}...`);
  try {
    const res = await fetch('/api/service/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, actionName })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`Service "${actionName}" started.`);
      fetchStatuses();
    } else {
      showToast(`Failed to start service.`);
    }
  } catch (err) {
    showToast(`Error starting service: ${err.message}`);
  }
}

// Stop background service
async function stopServiceAction(projectId, actionName) {
  showToast(`Stopping service: ${actionName}...`);
  try {
    const res = await fetch('/api/service/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, actionName })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`Service "${actionName}" stopped.`);
      fetchStatuses();
    } else {
      showToast(`Failed to stop service.`);
    }
  } catch (err) {
    showToast(`Error stopping service: ${err.message}`);
  }
}

// Open URL actions (locally or in host browser)
async function openUrlAction(projectId, actionIndex) {
  const project = dashboardConfig.projects.find(p => p.id === projectId);
  const action = project.actions[actionIndex];
  
  showToast(`Opening: ${action.url}`);
  
  try {
    // Request backend to open in host default browser (KDE context)
    const res = await fetch('/api/action/url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: action.url })
    });
    const data = await res.json();
    
    // In case host launcher failed or dashboard is accessed remotely, open in current tab as fallback
    if (data.hostOpenFailed) {
      window.open(action.url, '_blank');
    }
  } catch (err) {
    // Fallback if backend API has issue
    window.open(action.url, '_blank');
  }
}

// Open Logs Overlay Drawer
async function openLogsDrawer(projectId, actionName) {
  activeLogService = { projectId, actionName };
  
  const project = dashboardConfig.projects.find(p => p.id === projectId);
  document.getElementById('drawer-title').textContent = `${actionName} Console`;
  document.getElementById('drawer-subtitle').textContent = `${project.name} (${project.path})`;
  
  const logWindow = document.getElementById('service-log-window');
  logWindow.innerHTML = '<span class="text-muted">Loading service logs...</span>';
  
  // Show drawer
  document.getElementById('logs-drawer').classList.add('active');
  document.getElementById('logs-drawer-overlay').classList.add('active');
  
  // Fetch historical logs
  try {
    const res = await fetch(`/api/service/logs?projectId=${projectId}&actionName=${encodeURIComponent(actionName)}`);
    const data = await res.json();
    logWindow.innerHTML = '';
    
    if (data.logs.length === 0) {
      logWindow.innerHTML = '<span class="text-muted">No logs recorded yet.</span>';
    } else {
      data.logs.forEach(log => appendLogLineToUI(log));
    }
    logWindow.scrollTop = logWindow.scrollHeight;
  } catch (err) {
    logWindow.innerHTML = `<span class="error">Failed to fetch logs: ${err.message}</span>`;
  }
}

// Add a log line to terminal window
function appendLogLineToUI(log) {
  const logWindow = document.getElementById('service-log-window');

  // Remove placeholder if present
  const placeholder = logWindow.querySelector('.text-muted');
  if (placeholder) placeholder.remove();

  // If this line is a \r progress-bar replacement, overwrite the last DOM row
  if (log.replace) {
    const lastLine = logWindow.querySelector('.log-line:last-child');
    if (lastLine) {
      lastLine.querySelector('.log-content').textContent = log.text;
      logWindow.scrollTop = logWindow.scrollHeight;
      return;
    }
  }

  const div = document.createElement('div');
  div.className = 'log-line';

  const time = new Date(log.timestamp).toLocaleTimeString();
  div.innerHTML = `<span class="log-time">[${time}]</span><span class="log-content"></span>`;

  // Use textContent to prevent HTML injection of log lines
  div.querySelector('.log-content').textContent = log.text;
  logWindow.appendChild(div);

  // Cap lines count in DOM to prevent browser lag (keep 1000)
  if (logWindow.childNodes.length > 1000) {
    logWindow.firstChild.remove();
  }
}

// Close drawer
function closeLogsDrawer() {
  activeLogService = null;
  if (activeDockerLogInterval) {
    clearInterval(activeDockerLogInterval);
    activeDockerLogInterval = null;
  }
  document.getElementById('logs-drawer').classList.remove('active');
  document.getElementById('logs-drawer-overlay').classList.remove('active');
}

// Docker controls
async function startDockerContainer(projectId, containerName) {
  showToast(`Starting container: ${containerName}...`);
  try {
    const res = await fetch('/api/docker/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ container: containerName })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`Container ${containerName} started successfully.`);
      fetchStatuses();
    } else {
      showToast(`Failed to start container: ${data.error}`);
    }
  } catch (err) {
    showToast(`Error: ${err.message}`);
  }
}

async function stopDockerContainer(projectId, containerName) {
  showToast(`Stopping container: ${containerName}...`);
  try {
    const res = await fetch('/api/docker/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ container: containerName })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`Container ${containerName} stopped successfully.`);
      fetchStatuses();
    } else {
      showToast(`Failed to stop container: ${data.error}`);
    }
  } catch (err) {
    showToast(`Error: ${err.message}`);
  }
}

async function openDockerLogsDrawer(projectId, containerName) {
  closeLogsDrawer(); // Clear previous intervals & reset drawer state
  
  const drawer = document.getElementById('logs-drawer');
  const title = document.getElementById('drawer-title');
  const subtitle = document.getElementById('drawer-subtitle');
  const logWindow = document.getElementById('service-log-window');
  
  const proj = dashboardConfig?.projects.find(p => p.id === projectId);
  if (title) title.textContent = `Docker Logs: ${containerName}`;
  if (subtitle) subtitle.textContent = proj ? proj.name : 'Container';
  logWindow.innerHTML = '<span class="text-muted">Loading logs from Docker...</span>';
  
  drawer.classList.add('active');
  document.getElementById('logs-drawer-overlay').classList.add('active');
  
  const fetchDockerLogs = async () => {
    try {
      const res = await fetch(`/api/docker/logs/${containerName}`);
      const data = await res.json();
      if (data.success) {
        // Escape HTML
        const escaped = data.logs
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
        logWindow.innerHTML = escaped.split('\n').map(line => {
          return `<div class="log-line"><span class="log-content">${line}</span></div>`;
        }).join('');
        logWindow.scrollTop = logWindow.scrollHeight;
      } else {
        logWindow.innerHTML = `<span class="error">Failed to load logs: ${data.error || 'Unknown error'}</span>`;
      }
    } catch (err) {
      logWindow.innerHTML = `<span class="error">Network error: ${err.message}</span>`;
    }
  };
  
  await fetchDockerLogs();
  activeDockerLogInterval = setInterval(fetchDockerLogs, 2000);
}

function switchTab(tab) {
  activeTab = tab;
  activeCategory = 'all';
  
  // Update UI active styles
  document.querySelectorAll('.main-tab-btn').forEach(btn => {
    btn.classList.remove('active');
  });
  
  const activeBtn = document.getElementById(`tab-${tab}`);
  if (activeBtn) activeBtn.classList.add('active');
  
  refreshCategories();
  renderProjects();
}

// Hide project permanently
async function hideProjectCard(event, projectId, isDocker) {
  event.stopPropagation();
  const confirmHide = confirm(`Are you sure you want to permanently hide this project from the dashboard?\n(You can re-enable it by setting "hidden: false" or removing "hidden: true" in the corresponding configuration file)`);
  if (!confirmHide) return;
  
  showToast("Hiding project...");
  try {
    const res = await fetch('/api/project/hide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, isDocker })
    });
    const data = await res.json();
    if (data.success) {
      showToast("Project hidden permanently.");
      fetchConfig();
    } else {
      showToast(`Failed to hide: ${data.error}`);
    }
  } catch (err) {
    showToast(`Error: ${err.message}`);
  }
}

// System stats widgets updating
function updateSystemMonitor(stats) {
  // CPU
  document.getElementById('cpu-percent').textContent = `${Math.round(stats.cpu.load)}%`;
  document.getElementById('cpu-progress').style.width = `${stats.cpu.load}%`;
  
  // Memory
  const activeGb = (stats.memory.active / 1024 / 1024 / 1024).toFixed(1);
  const totalGb = (stats.memory.total / 1024 / 1024 / 1024).toFixed(1);
  document.getElementById('mem-percent').textContent = `${Math.round(stats.memory.usedPercent)}%`;
  document.getElementById('mem-progress').style.width = `${stats.memory.usedPercent}%`;
  document.getElementById('mem-text').textContent = `${activeGb} GB / ${totalGb} GB`;
  
  // Disks - show specific mount points
  const diskContainer = document.getElementById('disk-entries');
  const targetMounts = ['/', '/srv/plex', '/srv/musicals'];
  const mountLabels = {
    '/': '/ (Root)',
    '/srv/plex': '/srv/plex (MergerFS)',
    '/srv/musicals': '/srv/musicals (MergerFS)'
  };
  
  const matchedDisks = targetMounts
    .map(mount => stats.disk.find(d => d.mount === mount))
    .filter(Boolean);
  
  if (matchedDisks.length > 0) {
    diskContainer.innerHTML = matchedDisks.map(d => {
      const usedGb = ((d.size * (d.use / 100)) / 1024 / 1024 / 1024).toFixed(0);
      const sizeGb = (d.size / 1024 / 1024 / 1024).toFixed(0);
      const sizeTb = (d.size / 1024 / 1024 / 1024 / 1024);
      const usedTb = (d.size * (d.use / 100) / 1024 / 1024 / 1024 / 1024);
      const displayUsed = sizeTb >= 1 ? `${usedTb.toFixed(1)} TB` : `${usedGb} GB`;
      const displayTotal = sizeTb >= 1 ? `${sizeTb.toFixed(1)} TB` : `${sizeGb} GB`;
      const label = mountLabels[d.mount] || d.mount;
      return `
        <div class="disk-entry">
          <div class="stat-label">
            <span class="disk-mount-name">${label}</span>
            <span>${Math.round(d.use)}%</span>
          </div>
          <div class="progress-bar-container">
            <div class="progress-bar progress-disk" style="width: ${d.use}%"></div>
          </div>
          <div class="stat-subtext">${displayUsed} / ${displayTotal}</div>
        </div>
      `;
    }).join('');
  }
  
  // System Metadata
  document.getElementById('os-distro').textContent = `${stats.os.distro || stats.os.platform}`;
  document.getElementById('os-hostname').textContent = stats.os.hostname;
  
  // Uptime
  const uptimeSeconds = stats.os.uptime;
  const hours = Math.floor(uptimeSeconds / 3600).toString().padStart(2, '0');
  const minutes = Math.floor((uptimeSeconds % 3600) / 60).toString().padStart(2, '0');
  const secs = Math.floor(uptimeSeconds % 60).toString().padStart(2, '0');
  document.getElementById('uptime-display').textContent = `Uptime: ${hours}:${minutes}:${secs}`;
}

// Server-Sent Events listener setup
function setupEventSource() {
  if (eventSource) {
    eventSource.close();
  }
  
  eventSource = new EventSource('/api/events');
  
  eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    
    if (data.type === 'config_reload') {
      showToast('Configuration file reloaded!');
      dashboardConfig = data.data;
      applyUITheme(dashboardConfig);
      refreshCategories();
      renderQuickLinks(dashboardConfig.quick_links);
      renderBookmarks(dashboardConfig.bookmarks);
      renderProjects();
      
      applyTabOrder();
      applySidebarWidgetsOrder();
      applyEditModeLayoutStates();
    }
    
    else if (data.type === 'service_status') {
      const { key, status, exitCode } = data.data;
      const [projId, actName] = key.split(':');
      
      // Refresh statuses locally to trigger GUI switches
      fetchStatuses();
      
      if (activeLogService && activeLogService.projectId === projId && activeLogService.actionName === actName) {
        const logWindow = document.getElementById('service-log-window');
        const div = document.createElement('div');
        div.className = 'log-line';
        div.style.color = status === 'running' ? 'var(--success)' : status === 'failed' ? 'var(--error)' : 'var(--text-muted)';
        div.innerHTML = `<span class="log-time">[System]</span> <span class="log-content">Service state changed to: ${status} ${exitCode !== undefined ? `(Exit code: ${exitCode})` : ''}</span>`;
        logWindow.appendChild(div);
        logWindow.scrollTop = logWindow.scrollHeight;
      }
    }
    
    else if (data.type === 'service_log') {
      const { key, log } = data.data;
      const [projId, actName] = key.split(':');
      
      if (activeLogService && activeLogService.projectId === projId && activeLogService.actionName === actName) {
        appendLogLineToUI(log);
        const logWindow = document.getElementById('service-log-window');
        logWindow.scrollTop = logWindow.scrollHeight;
      }
    }
    
    else if (data.type === 'background_change') {
      updateBackground(true);
    }
  };
  
  eventSource.onerror = (err) => {
    console.error('SSE connection error, reconnecting...', err);
    setTimeout(setupEventSource, 3000); // Reconnect in 3s
  };
}



// Attach Event Listeners
document.getElementById('btn-close-drawer').addEventListener('click', closeLogsDrawer);
document.getElementById('logs-drawer-overlay').addEventListener('click', closeLogsDrawer);

document.getElementById('btn-clear-logs').addEventListener('click', () => {
  document.getElementById('service-log-window').innerHTML = '<span class="text-muted">Console cleared.</span>';
});

document.getElementById('btn-copy-logs').addEventListener('click', () => {
  const logLines = Array.from(document.querySelectorAll('#service-log-window .log-content'))
    .map(el => el.textContent)
    .join('\n');
  
  navigator.clipboard.writeText(logLines)
    .then(() => showToast('Logs copied to clipboard'))
    .catch(err => showToast('Failed to copy: ' + err.message));
});

// Global Omni-Search, History, and Predictions
let searchHistory = JSON.parse(localStorage.getItem('dashboard_search_history') || '[]');
let dropdownResults = [];
let activeDropdownIndex = -1;

function saveSearchHistory(item) {
  // Remove duplicate entries
  searchHistory = searchHistory.filter(h => !(h.name === item.name && h.type === item.type));
  // Add to front
  searchHistory.unshift({
    type: item.type,
    name: item.name,
    id: item.id || null,
    path: item.path || null,
    url: item.url || null,
    details: item.details || null,
    icon: item.icon || null,
    timestamp: Date.now()
  });
  // Limit to 300 items
  if (searchHistory.length > 300) {
    searchHistory = searchHistory.slice(0, 300);
  }
  localStorage.setItem('dashboard_search_history', JSON.stringify(searchHistory));
}

function showSearchDropdown() {
  const input = document.getElementById('project-search');
  const dropdown = document.getElementById('search-results-dropdown');
  const val = input.value.trim().toLowerCase();
  
  if (!dashboardConfig) {
    dropdown.style.display = 'none';
    return;
  }

  // Gather searchable items
  const items = [];
  
  // Folders
  (dashboardConfig.quick_links || []).forEach(f => {
    items.push({ type: 'folder', name: f.name, path: f.path, icon: f.icon || '📂', details: `Folder: ${f.path}` });
  });
  // Bookmarks
  (dashboardConfig.bookmarks || []).forEach(b => {
    items.push({ type: 'bookmark', name: b.name, url: b.url, icon: b.icon || '🔗', details: `Bookmark: ${b.url}` });
  });
  // Projects
  (dashboardConfig.projects || []).forEach(p => {
    items.push({ type: 'project', name: p.name, id: p.id, category: p.category, icon: p.icon || '📦', details: `Project (${p.category}) - ${p.path || ''}` });
  });
  // Docker
  (dashboardConfig.docker || []).forEach(d => {
    const dockerName = d.status?.docker || d.id;
    const stackName = dashboardConfig.dockerStacks?.mapping?.[dockerName] || 'containers';
    items.push({ type: 'docker', name: d.name, id: d.id, dockerName, stack: stackName, icon: d.icon || '🐳', details: `Docker [${stackName}] - Port ${d.status?.port || 'N/A'}` });
  });

  dropdownResults = [];
  
  if (!val) {
    // Show recent history (up to 10 items)
    if (searchHistory.length > 0) {
      dropdownResults = searchHistory.slice(0, 10).map(h => {
        // Match against active dashboard objects to keep information fresh
        const matched = items.find(item => item.name === h.name && item.type === h.type);
        return matched ? matched : h;
      });
      renderDropdownItems(dropdownResults, 'Recent Searches', dropdown);
    } else {
      dropdown.style.display = 'none';
    }
    return;
  }

  // Check if input is a URL
  const isUrl = val.startsWith('http://') || val.startsWith('https://') || /^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(val);
  if (isUrl) {
    const targetUrl = val.match(/^https?:\/\//) ? val : 'http://' + val;
    dropdownResults.push({ type: 'url', name: `Open URL: ${val}`, url: targetUrl, icon: '🌐', details: targetUrl, score: 999 });
  }

  // Calculate matching scores
  items.forEach(item => {
    let score = 0;
    const name = item.name.toLowerCase();
    const details = item.details.toLowerCase();
    
    if (name === val) {
      score += 100;
    } else if (name.startsWith(val)) {
      score += 80;
    } else if (name.includes(val)) {
      score += 50;
    } else if (details.includes(val)) {
      score += 25;
    }
    
    if (score > 0) {
      // Recency boost
      const idx = searchHistory.findIndex(h => h.name === item.name && h.type === item.type);
      if (idx !== -1) {
        score += (300 - idx) * 0.1;
      }
      
      // Frequency boost
      const freq = searchHistory.filter(h => h.name === item.name && h.type === item.type).length;
      score += freq * 5;
      
      item.score = score;
      dropdownResults.push(item);
    }
  });

  // Sort by score
  dropdownResults.sort((a, b) => b.score - a.score);
  
  // Limit to 10 results
  dropdownResults = dropdownResults.slice(0, 10);
  
  if (dropdownResults.length > 0) {
    renderDropdownItems(dropdownResults, 'Search Results', dropdown);
  } else {
    dropdown.style.display = 'none';
  }
}

function renderDropdownItems(results, headerText, dropdown) {
  dropdown.innerHTML = `
    <div class="search-dropdown-header">${headerText}</div>
  `;
  
  results.forEach((item, index) => {
    const div = document.createElement('div');
    div.className = 'search-dropdown-item';
    if (index === activeDropdownIndex) {
      div.classList.add('active');
    }
    
    div.innerHTML = `
      <span class="search-dropdown-item-icon">${getIconMarkup(item.icon, 'search')}</span>
      <div class="search-dropdown-item-info">
        <span class="search-dropdown-item-name">${item.name}</span>
        <span class="search-dropdown-item-meta">${item.details || item.type}</span>
      </div>
    `;
    
    div.addEventListener('click', () => selectSearchItem(item));
    dropdown.appendChild(div);
  });
  
  dropdown.style.display = 'block';
  lucide.createIcons();
}

function selectSearchItem(item) {
  saveSearchHistory(item);
  
  document.getElementById('search-results-dropdown').style.display = 'none';
  const input = document.getElementById('project-search');
  input.value = '';
  searchFilter = '';
  
  // Restore basic listings
  renderProjects();
  if (dashboardConfig) {
    renderQuickLinks(dashboardConfig.quick_links);
    renderBookmarks(dashboardConfig.bookmarks);
  }

  // Handle actions based on item type
  if (item.type === 'bookmark' || item.type === 'url') {
    triggerHostOpenUrl(item.url);
  } else if (item.type === 'folder') {
    openFolderShortcut(item.path);
  } else if (item.type === 'project') {
    switchTab('projects');
    setTimeout(() => {
      const card = document.querySelector(`.project-card[data-id="${item.id}"]`);
      if (card) {
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        card.style.borderColor = 'var(--accent-gold)';
        card.style.boxShadow = '0 0 20px rgba(224, 180, 48, 0.6)';
        setTimeout(() => {
          card.style.borderColor = '';
          card.style.boxShadow = '';
        }, 3000);
      }
    }, 100);
  } else if (item.type === 'docker') {
    switchTab('docker');
    setTimeout(() => {
      const card = document.querySelector(`.project-card[data-id="${item.id}"]`);
      if (card) {
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        card.style.borderColor = 'var(--accent-gold)';
        card.style.boxShadow = '0 0 20px rgba(224, 180, 48, 0.6)';
        setTimeout(() => {
          card.style.borderColor = '';
          card.style.boxShadow = '';
        }, 3000);
      }
    }, 100);
  }
}

// Bind search listeners
const searchInputEl = document.getElementById('project-search');

searchInputEl.addEventListener('input', (e) => {
  searchFilter = e.target.value;
  activeDropdownIndex = -1;
  showSearchDropdown();
  
  // Also keep default page filtering active (only projects/docker containers)
  renderProjects();
});

searchInputEl.addEventListener('focus', () => {
  activeDropdownIndex = -1;
  showSearchDropdown();
});

searchInputEl.addEventListener('keydown', (e) => {
  const dropdown = document.getElementById('search-results-dropdown');
  if (dropdown.style.display === 'none') return;
  
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    activeDropdownIndex = Math.min(activeDropdownIndex + 1, dropdownResults.length - 1);
    showSearchDropdown();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    activeDropdownIndex = Math.max(activeDropdownIndex - 1, -1);
    showSearchDropdown();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (activeDropdownIndex >= 0 && activeDropdownIndex < dropdownResults.length) {
      selectSearchItem(dropdownResults[activeDropdownIndex]);
    } else if (dropdownResults.length > 0) {
      selectSearchItem(dropdownResults[0]);
    }
  } else if (e.key === 'Escape') {
    dropdown.style.display = 'none';
    searchInputEl.blur();
  }
});

document.addEventListener('click', (e) => {
  const dropdown = document.getElementById('search-results-dropdown');
  const input = document.getElementById('project-search');
  if (dropdown && !dropdown.contains(e.target) && e.target !== input) {
    dropdown.style.display = 'none';
  }
});

// Dropdown Toggle
const dropdownToggle = document.getElementById('btn-edit-dropdown-toggle');
const dropdownMenu = document.getElementById('edit-dropdown-menu');

if (dropdownToggle && dropdownMenu) {
  dropdownToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    const isShown = dropdownMenu.style.display === 'flex' || dropdownMenu.style.display === 'block';
    dropdownMenu.style.display = isShown ? 'none' : 'flex';
  });
  
  document.addEventListener('click', (e) => {
    if (!dropdownToggle.contains(e.target) && !dropdownMenu.contains(e.target)) {
      dropdownMenu.style.display = 'none';
    }
  });
}

// Randomize Wallpaper button
document.getElementById('btn-random-bg').addEventListener('click', randomizeWallpaper);

// Initialize Page
async function init() {
  updateBackground(false);
  await fetchConfig();
  await fetchStatuses();
  await fetchSystemStats();
  
  setupEventSource();
  
  // Set up compact mode state on init
  updateCompactModeUI();
  
  // Set up periodic loops
  const refreshInterval = dashboardConfig?.ui?.refresh_interval_ms || 5000;
  setInterval(fetchStatuses, refreshInterval);
  setInterval(fetchSystemStats, 2000); // System stats every 2s
}

// Expose handlers globally for onclick attributes
window.runCommandAction = runCommandAction;
window.runStreamAction = runStreamAction;
window.startServiceAction = startServiceAction;
window.stopServiceAction = stopServiceAction;
window.openUrlAction = openUrlAction;
window.openLogsDrawer = openLogsDrawer;
window.startDockerContainer = startDockerContainer;
window.stopDockerContainer = stopDockerContainer;
window.openDockerLogsDrawer = openDockerLogsDrawer;
window.switchTab = switchTab;
window.hideProjectCard = hideProjectCard;
window.toggleEditMode = toggleEditMode;
window.triggerHostOpenUrl = triggerHostOpenUrl;
window.toggleCompactMode = toggleCompactMode;

// Layout Drag & Drop system
let dragSrcEl = null;

function makeDraggable(element) {
  element.addEventListener('dragstart', handleDragStart);
  element.addEventListener('dragover', handleDragOver);
  element.addEventListener('dragenter', handleDragEnter);
  element.addEventListener('dragleave', handleDragLeave);
  element.addEventListener('drop', handleDrop);
  element.addEventListener('dragend', handleDragEnd);
}

function handleDragStart(e) {
  if (!isEditMode) return;
  dragSrcEl = this;
  e.dataTransfer.effectAllowed = 'move';
  const val = this.getAttribute('data-id') || this.getAttribute('data-name') || this.getAttribute('data-category') || this.id;
  e.dataTransfer.setData('text/plain', val || '');
  this.classList.add('dragging');
}

function handleDragOver(e) {
  if (!isEditMode) return;
  if (e.preventDefault) {
    e.preventDefault();
  }
  e.dataTransfer.dropEffect = 'move';
  return false;
}

function handleDragEnter(e) {
  if (!isEditMode) return;
  this.classList.add('drag-over');
}

function handleDragLeave(e) {
  if (!isEditMode) return;
  this.classList.remove('drag-over');
}

function handleDrop(e) {
  if (!isEditMode) return;
  e.stopPropagation();
  e.preventDefault();
  
  if (dragSrcEl !== this && dragSrcEl.parentNode === this.parentNode) {
    const parent = this.parentNode;
    const children = Array.from(parent.children);
    const srcIndex = children.indexOf(dragSrcEl);
    const destIndex = children.indexOf(this);
    
    if (srcIndex < destIndex) {
      parent.insertBefore(dragSrcEl, this.nextSibling);
    } else {
      parent.insertBefore(dragSrcEl, this);
    }
    
    saveNewOrder(parent);
  }
  return false;
}

function handleDragEnd(e) {
  if (!isEditMode) return;
  document.querySelectorAll('.dragging').forEach(el => el.classList.remove('dragging'));
  document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
}

async function saveNewOrder(parent) {
  let type = '';
  let items = [];
  
  if (parent.id === 'projects-grid-container') {
    type = activeTab === 'projects' ? 'projects' : 'docker';
    items = Array.from(parent.children)
      .map(child => child.getAttribute('data-id'))
      .filter(Boolean);
  } else if (parent.id === 'quick-links-container') {
    type = 'quick_links';
    items = Array.from(parent.children)
      .map(child => child.getAttribute('data-name'))
      .filter(Boolean);
  } else if (parent.id === 'bookmarks-container') {
    type = 'bookmarks';
    items = Array.from(parent.children)
      .map(child => child.getAttribute('data-name'))
      .filter(Boolean);
  } else if (parent.classList.contains('project-tabs-container')) {
    type = 'tab_order';
    items = Array.from(parent.children)
      .map(child => child.id.replace('tab-', ''))
      .filter(Boolean);
  } else if (parent.id === 'categories-tabs-container') {
    type = 'categories';
    items = Array.from(parent.children)
      .map(child => child.getAttribute('data-category'))
      .filter(Boolean);
  } else if (parent.classList.contains('dashboard-sidebar')) {
    type = 'sidebar_widgets';
    items = Array.from(parent.children)
      .map(child => child.id)
      .filter(Boolean);
  }
  
  if (!type || items.length === 0) return;
  
  showToast(`Saving new layout order...`);
  try {
    const res = await fetch('/api/layout/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, items })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`Layout updated successfully!`);
    } else {
      showToast(`Failed to update layout: ${data.error}`);
    }
  } catch (err) {
    showToast(`Error: ${err.message}`);
  }
}

function applyTabOrder() {
  const tabOrder = dashboardConfig?.ui?.tab_order;
  if (!tabOrder || tabOrder.length === 0) return;
  const container = document.querySelector('.project-tabs-container');
  if (!container) return;
  
  tabOrder.forEach(tabId => {
    const btn = document.getElementById(`tab-${tabId}`);
    if (btn) container.appendChild(btn);
  });
}

function applySidebarWidgetsOrder() {
  const widgetOrder = dashboardConfig?.ui?.sidebar_widgets_order;
  if (!widgetOrder || widgetOrder.length === 0) return;
  const container = document.querySelector('.dashboard-sidebar');
  if (!container) return;
  
  widgetOrder.forEach(widgetId => {
    const el = document.getElementById(widgetId);
    if (el) container.appendChild(el);
  });
}

function applyEditModeLayoutStates() {
  const sidebar = document.querySelector('.dashboard-sidebar');
  const projectTabs = document.querySelector('.project-tabs-container');
  
  if (sidebar) {
    Array.from(sidebar.children).forEach(child => {
      if (child.classList.contains('widget-card')) {
        if (isEditMode) {
          child.setAttribute('draggable', 'true');
          makeDraggable(child);
        } else {
          child.setAttribute('draggable', 'false');
        }
      }
    });
  }
  
  if (projectTabs) {
    Array.from(projectTabs.children).forEach(child => {
      if (child.classList.contains('main-tab-btn')) {
        if (isEditMode) {
          child.setAttribute('draggable', 'true');
          makeDraggable(child);
        } else {
          child.setAttribute('draggable', 'false');
        }
      }
    });
  }
}

let isEditUiMode = false;

function handleMenuEditLayout() {
  document.getElementById('edit-dropdown-menu').style.display = 'none';
  toggleEditMode();
}

function handleMenuEditConfig() {
  document.getElementById('edit-dropdown-menu').style.display = 'none';
  showToast('Opening config.yaml in code editor...');
  const path = dashboardConfig?.projects.find(p => p.id === 'dashboard')?.path || '.';
  fetch('/api/action/command', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cmd: 'cursor config.yaml || code config.yaml || xdg-open config.yaml',
      path: path
    })
  }).catch(err => console.error('Failed to open config file:', err));
}

function toggleEditMode() {
  isEditMode = !isEditMode;
  
  const toggleBtn = document.getElementById('btn-edit-dropdown-toggle');
  const toggleText = document.getElementById('edit-dropdown-text');
  const layoutMenuBtn = document.getElementById('item-edit-layout');
  
  if (isEditMode) {
    if (isEditUiMode) {
      isEditUiMode = false;
      const uiMenuBtn = document.getElementById('item-edit-ui');
      uiMenuBtn.querySelector('span').textContent = 'Edit UI Elements';
      const titleEl = document.getElementById('dashboard-title');
      if (titleEl) {
        titleEl.classList.remove('edit-ui-editable');
        titleEl.onclick = null;
      }
    }
    
    toggleBtn.classList.add('edit-ui-active-badge');
    toggleText.textContent = 'Editing Layout...';
    layoutMenuBtn.querySelector('span').textContent = 'Exit Edit Layout';
    showToast('Edit Layout mode activated. Drag elements to rearrange.');
  } else {
    toggleBtn.classList.remove('edit-ui-active-badge');
    toggleText.textContent = 'Edit Dashboard';
    layoutMenuBtn.querySelector('span').textContent = 'Edit Layout';
    showToast('Edit Layout mode deactivated.');
  }
  
  if (dashboardConfig) {
    renderQuickLinks(dashboardConfig.quick_links);
    renderBookmarks(dashboardConfig.bookmarks);
    refreshCategories();
    renderProjects();
    
    applyTabOrder();
    applySidebarWidgetsOrder();
    applyEditModeLayoutStates();
  }
}

function toggleEditUiMode() {
  isEditUiMode = !isEditUiMode;
  document.getElementById('edit-dropdown-menu').style.display = 'none';
  
  const toggleBtn = document.getElementById('btn-edit-dropdown-toggle');
  const toggleText = document.getElementById('edit-dropdown-text');
  const uiMenuBtn = document.getElementById('item-edit-ui');
  
  if (isEditUiMode) {
    if (isEditMode) {
      isEditMode = false;
      const layoutMenuBtn = document.getElementById('item-edit-layout');
      layoutMenuBtn.querySelector('span').textContent = 'Edit Layout';
    }
    
    toggleBtn.classList.add('edit-ui-active-badge');
    toggleText.textContent = 'Editing UI...';
    uiMenuBtn.querySelector('span').textContent = 'Exit Edit UI';
    showToast('Edit UI mode enabled. Click dashed elements or edit buttons to customize.');
  } else {
    toggleBtn.classList.remove('edit-ui-active-badge');
    toggleText.textContent = 'Edit Dashboard';
    uiMenuBtn.querySelector('span').textContent = 'Edit UI Elements';
    showToast('Edit UI mode disabled.');
  }
  
  const titleEl = document.getElementById('dashboard-title');
  if (titleEl) {
    if (isEditUiMode) {
      titleEl.classList.add('edit-ui-editable');
      titleEl.onclick = handleTitleEdit;
    } else {
      titleEl.classList.remove('edit-ui-editable');
      titleEl.onclick = null;
    }
  }
  
  if (dashboardConfig) {
    renderQuickLinks(dashboardConfig.quick_links);
    renderBookmarks(dashboardConfig.bookmarks);
    refreshCategories();
    renderProjects();
  }
}

// ── Edit Panel ──────────────────────────────────────────────────────────────

const ALL_ICONS = [
  'rocket','folder','folder-open','link','server','cpu','database','terminal',
  'globe','book','book-open','music','video','film','image','mail','inbox',
  'message-square','message-circle','shield','key','lock','unlock','download',
  'upload','cloud','cloud-upload','cloud-download','activity','star','heart',
  'tv','monitor','chrome','code','code-2','disc','wifi','wifi-off','power',
  'compass','anchor','box','package','settings','settings-2','sliders',
  'alert-triangle','alert-circle','help-circle','info','check-circle',
  'x-circle','plus-circle','minus-circle','eye','eye-off','search','home',
  'layout-dashboard','grid','list','layers','share-2','external-link','flag',
  'tag','tags','calendar','clock','timer','zap','flame','wrench','tool',
  'hammer','scissors','pen','pencil','edit','edit-2','edit-3','trash','trash-2',
  'save','file','file-text','files','archive','hard-drive','cpu','microchip',
  'bot','user','users','user-check','person-standing','briefcase','graduation-cap',
  'map','map-pin','navigation','car','truck','plane','ship','train',
  'gamepad-2','joystick','sword','shield-check','fingerprint','scan',
  'bar-chart','bar-chart-2','pie-chart','trending-up','trending-down',
  'git-branch','git-commit','git-merge','github','gitlab','docker',
  'play','pause','stop-circle','skip-forward','volume-2','headphones',
  'camera','aperture','photo','gallery-thumbnails','sparkles','wand-2'
];

let epCurrentType = null;
let epCurrentId   = null;
let epCurrentIndex = null;
let epActiveFields = [];

function openEditPanel(label, type, id, index, fields, values = {}) {
  epCurrentType  = type;
  epCurrentId    = id;
  epCurrentIndex = index;
  epActiveFields = fields;

  document.getElementById('edit-panel-label').textContent = label;

  const show = (id, visible) => {
    const el = document.getElementById(id);
    if (el) el.style.display = visible ? 'flex' : 'none';
  };

  show('ep-group-name',  fields.includes('name'));
  show('ep-group-desc',  fields.includes('description'));
  show('ep-group-url',   fields.includes('url'));
  show('ep-group-path',  fields.includes('path'));
  show('ep-group-icon',  fields.includes('icon'));

  if (fields.includes('name'))        document.getElementById('ep-name').value  = values.name  || '';
  if (fields.includes('description')) document.getElementById('ep-desc').value  = values.description || '';
  if (fields.includes('url'))         document.getElementById('ep-url').value   = values.url   || '';
  if (fields.includes('path'))        document.getElementById('ep-path').value  = values.path  || '';
  if (fields.includes('icon'))        document.getElementById('ep-icon-val').value = values.icon || '';

  if (fields.includes('icon')) {
    updateIconPreview(values.icon || '');
    buildIconGrid('');
  }

  const panel = document.getElementById('edit-panel');
  panel.style.display = 'flex';
  // Re-trigger animation
  panel.style.animation = 'none';
  panel.offsetHeight;
  panel.style.animation = '';

  if (window.lucide) lucide.createIcons();
}

function closeEditPanel() {
  document.getElementById('edit-panel').style.display = 'none';
  epCurrentType = epCurrentId = epCurrentIndex = null;
  epActiveFields = [];
}

function updateIconPreview(val) {
  const prev = document.getElementById('ep-icon-preview');
  if (!prev) return;
  val = (val || '').trim();
  if (!val) {
    prev.innerHTML = '<i data-lucide="image" style="width:18px;height:18px;opacity:0.4;"></i>';
    if (window.lucide) lucide.createIcons();
    return;
  }
  if (val.startsWith('http') || val.endsWith('.png') || val.endsWith('.jpg') || val.endsWith('.svg') || val.endsWith('.webp')) {
    prev.innerHTML = `<img src="${val}" alt="icon" onerror="this.style.display='none'">`;
  } else if (/^[a-z0-9-]+$/i.test(val)) {
    prev.innerHTML = `<i data-lucide="${val}" style="width:20px;height:20px;"></i>`;
    if (window.lucide) lucide.createIcons();
  } else {
    prev.textContent = val;
  }
}

function buildIconGrid(filter) {
  const grid = document.getElementById('ep-icon-grid');
  if (!grid) return;
  const current = document.getElementById('ep-icon-val').value.trim();
  const filtered = filter
    ? ALL_ICONS.filter(n => n.includes(filter.toLowerCase()))
    : ALL_ICONS;

  grid.innerHTML = '';
  filtered.forEach(name => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ep-icon-btn' + (name === current ? ' selected' : '');
    btn.title = name;
    btn.innerHTML = `<i data-lucide="${name}"></i>`;
    btn.addEventListener('click', () => {
      document.getElementById('ep-icon-val').value = name;
      updateIconPreview(name);
      grid.querySelectorAll('.ep-icon-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
    });
    grid.appendChild(btn);
  });
  if (window.lucide) lucide.createIcons();
}

// Wire up the panel controls once DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('edit-panel-close').addEventListener('click', closeEditPanel);
  document.getElementById('ep-cancel').addEventListener('click', closeEditPanel);

  document.getElementById('ep-save').addEventListener('click', async () => {
    const props = {};
    if (epActiveFields.includes('name'))        props.name        = document.getElementById('ep-name').value.trim();
    if (epActiveFields.includes('description')) props.description = document.getElementById('ep-desc').value.trim();
    if (epActiveFields.includes('url'))         props.url         = document.getElementById('ep-url').value.trim();
    if (epActiveFields.includes('path'))        props.path        = document.getElementById('ep-path').value.trim();
    if (epActiveFields.includes('icon'))        props.icon        = document.getElementById('ep-icon-val').value.trim();
    if (epCurrentType === 'title')              props.title       = props.name;

    await updateUiElement(epCurrentType, epCurrentId, epCurrentIndex, props);
    closeEditPanel();
  });

  document.getElementById('ep-icon-val').addEventListener('input', (e) => {
    updateIconPreview(e.target.value);
  });

  document.getElementById('ep-icon-search').addEventListener('input', (e) => {
    buildIconGrid(e.target.value.trim());
  });
});

// Convenience wrappers (called by rendered elements)
async function handleTitleEdit(e) {
  e.preventDefault(); e.stopPropagation();
  const cur = document.getElementById('dashboard-title').textContent;
  openEditPanel('Edit Dashboard Title', 'title', null, null, ['name', 'icon'], { name: cur, icon: dashboardConfig?.ui?.icon || '' });
}

async function handleCategoryEdit(e, categoryId) {
  e.preventDefault(); e.stopPropagation();
  const cat = dashboardConfig?.categories?.find(c => c.id === categoryId);
  if (!cat) return;
  openEditPanel(`Category: ${cat.name}`, 'category', categoryId, null, ['name', 'icon'], { name: cat.name, icon: cat.icon });
}

async function handleShortcutEdit(e, index) {
  e.preventDefault(); e.stopPropagation();
  const link = dashboardConfig?.quick_links?.[index];
  if (!link) return;
  openEditPanel(`Folder Shortcut: ${link.name}`, 'shortcut', null, index, ['name', 'icon', 'path'], { name: link.name, icon: link.icon, path: link.path });
}

async function handleBookmarkEdit(e, index) {
  e.preventDefault(); e.stopPropagation();
  const bm = dashboardConfig?.bookmarks?.[index];
  if (!bm) return;
  openEditPanel(`Bookmark: ${bm.name}`, 'bookmark', null, index, ['name', 'icon', 'url'], { name: bm.name, icon: bm.icon, url: bm.url });
}

async function handleCardEdit(e, type, id) {
  e.preventDefault(); e.stopPropagation();
  let item = type === 'project'
    ? dashboardConfig?.projects?.find(p => p.id === id)
    : dashboardConfig?.docker?.find(d => d.id === id);
  if (!item) { showToast('Item not found'); return; }
  const label = type === 'docker' ? 'Docker Container' : 'Project';
  openEditPanel(`${label}: ${item.name}`, type, id, null, ['name', 'icon', 'description'],
    { name: item.name, icon: item.icon, description: item.description });
}

// Icon picker is now integrated into the edit panel; stub kept for compat
function showIconPicker() {}

async function updateUiElement(type, id, index, properties) {
  try {
    const response = await fetch('/api/ui/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, id, index, properties })
    });
    const data = await response.json();
    if (data.success) {
      showToast('Saved!');
    } else {
      showToast('Error: ' + (data.error || 'unknown'));
    }
  } catch (err) {
    showToast('Failed to connect to server');
    console.error(err);
  }
}

// Global URL click interceptor to route external links to Zen Browser via Flatpak
document.addEventListener('click', (e) => {
  if (isEditMode) return;
  
  const anchor = e.target.closest('a');
  if (anchor && anchor.href) {
    const url = anchor.href;
    // Intercept standard HTTP/HTTPS links
    if (url.startsWith('http://') || url.startsWith('https://')) {
      const localOrigin = window.location.origin;
      // Do not intercept if it's local dashboard routing (like href="#") or same-origin APIs
      if (!url.startsWith(localOrigin)) {
        e.preventDefault();
        triggerHostOpenUrl(url);
      }
    }
  }
});

async function triggerHostOpenUrl(url) {
  showToast(`Opening: ${url}`);
  try {
    const res = await fetch('/api/action/url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    const data = await res.json();
    if (data.hostOpenFailed) {
      window.open(url, '_blank');
    }
  } catch (err) {
    window.open(url, '_blank');
  }
}

function toggleCompactMode() {
  isCompactMode = !isCompactMode;
  localStorage.setItem('isCompactMode', isCompactMode);
  updateCompactModeUI();
}

function updateCompactModeUI() {
  const container = document.getElementById('projects-grid-container');
  const btn = document.getElementById('btn-toggle-compact');
  
  if (container) {
    if (isCompactMode) {
      container.classList.add('compact-mode');
    } else {
      container.classList.remove('compact-mode');
    }
  }
  
  if (btn) {
    if (isCompactMode) {
      btn.classList.add('active');
      btn.querySelector('span').textContent = 'Standard View';
      btn.querySelector('i').setAttribute('data-lucide', 'maximize-2');
    } else {
      btn.classList.remove('active');
      btn.querySelector('span').textContent = 'Compact View';
      btn.querySelector('i').setAttribute('data-lucide', 'minimize-2');
    }
    if (window.lucide) {
      lucide.createIcons();
    }
  }
}

document.addEventListener('DOMContentLoaded', init);
