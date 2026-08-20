import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { exec } from 'child_process';
import si from 'systeminformation';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

process.env.TERM = process.env.TERM || 'xterm-256color';

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const CONFIG_PATH = path.join(__dirname, 'config.yaml');

let config = null;

function saveConfig() {
  fs.writeFileSync(CONFIG_PATH, yaml.dump(config), 'utf8');
}

function loadConfig() {
  try {
    const fileContents = fs.readFileSync(CONFIG_PATH, 'utf8');
    config = yaml.load(fileContents);
    if (!config.quick_links) config.quick_links = [];
    if (!config.bookmarks) config.bookmarks = [];
    if (!config.system) config.system = {};
    if (!config.background) config.background = {};
    console.log('[Server] Configuration loaded/reloaded.');
    return true;
  } catch (e) {
    console.error('[Server] Failed to load configuration file:', e);
    return false;
  }
}

if (fs.existsSync(CONFIG_PATH)) {
  fs.watch(CONFIG_PATH, (eventType) => {
    if (eventType === 'change') {
      console.log('[Server] config.yaml changed. Reloading...');
      loadConfig();
      broadcastConfigReload();
    }
  });
}

loadConfig();

// Server-Sent Events broadcaster - just config_reload + background_change now
const sseClients = new Set();
function broadcastEvent(type, data) {
  const payload = JSON.stringify({ type, data });
  for (const client of sseClients) client.write(`data: ${payload}\n\n`);
}
// Strips server-side secrets (integrations block: API keys/tokens/passwords)
// before the config goes to the browser - the frontend never reads it, those
// credentials are only used by the proxy endpoints below.
function sanitizedConfig() {
  const { integrations, ...rest } = config;
  return rest;
}

function broadcastConfigReload() {
  broadcastEvent('config_reload', sanitizedConfig());
}

// APIs

app.get('/api/config', (req, res) => {
  res.json(sanitizedConfig());
});

// Run an immediate command (Terminal, Update, opening a folder)
app.post('/api/action/command', (req, res) => {
  const { cmd, path: cmdPath } = req.body;
  if (!cmd || !cmdPath) {
    return res.status(400).json({ error: 'Command and Path are required' });
  }
  console.log(`[API] Executing command: "${cmd}" in path: ${cmdPath}`);
  exec(cmd, { cwd: cmdPath, env: { ...process.env } }, (error, stdout, stderr) => {
    if (error) {
      console.error(`[API] Command failed: ${cmd}`, error);
      return res.status(500).json({ success: false, error: error.message, stderr: stderr.toString() });
    }
    res.json({ success: true, stdout: stdout.toString(), stderr: stderr.toString() });
  });
});

// Launch a bookmark URL via Zen Browser (Flatpak)
app.post('/api/action/url', (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  console.log(`[API] Opening URL on host via Zen Browser (Flatpak): ${url}`);
  const zenCmd = `/usr/bin/flatpak run --branch=stable --arch=x86_64 --command=launch-script.sh --file-forwarding app.zen_browser.zen @@u "${url}" @@`;
  exec(zenCmd, (error) => {
    if (error) {
      console.warn('[API] Failed to open URL via Zen Browser:', error.message);
      return res.json({ success: false, hostOpenFailed: true, error: error.message });
    }
    res.json({ success: true });
  });
});

// Update UI elements (title, bookmark, folder shortcut)
app.post('/api/ui/update', (req, res) => {
  const { type, index, properties } = req.body;
  if (!properties) return res.status(400).json({ error: 'Missing properties to update' });

  if (type === 'title') {
    if (config.ui) {
      config.ui.title = properties.title;
      saveConfig(); loadConfig(); broadcastConfigReload();
      return res.json({ success: true });
    }
  }
  if (type === 'shortcut') {
    const link = config.quick_links?.[index];
    if (link) {
      Object.assign(link, properties);
      saveConfig(); loadConfig(); broadcastConfigReload();
      return res.json({ success: true });
    }
  }
  if (type === 'bookmark') {
    const bm = config.bookmarks?.[index];
    if (bm) {
      Object.assign(bm, properties);
      saveConfig(); loadConfig(); broadcastConfigReload();
      return res.json({ success: true });
    }
  }
  return res.status(404).json({ error: 'Item not found or invalid type' });
});

// Reorder bookmarks/folders
app.post('/api/layout/reorder', (req, res) => {
  const { type, items } = req.body;
  if (!type || !items) return res.status(400).json({ error: 'Missing type or items' });

  if (type === 'quick_links') {
    const reordered = [];
    items.forEach(name => {
      const link = config.quick_links.find(l => l.name === name);
      if (link) reordered.push(link);
    });
    config.quick_links.forEach(link => {
      if (!reordered.some(l => l.name === link.name)) reordered.push(link);
    });
    config.quick_links = reordered;
    saveConfig(); loadConfig(); broadcastConfigReload();
    return res.json({ success: true });
  }
  if (type === 'bookmarks') {
    const reordered = [];
    items.forEach(name => {
      const bm = config.bookmarks.find(b => b.name === name);
      if (bm) reordered.push(bm);
    });
    config.bookmarks.forEach(bm => {
      if (!reordered.some(b => b.name === bm.name)) reordered.push(bm);
    });
    config.bookmarks = reordered;
    saveConfig(); loadConfig(); broadcastConfigReload();
    return res.json({ success: true });
  }
  return res.status(400).json({ error: 'Invalid reorder type' });
});

// Docker containers (for search) - queried live, nothing persisted
app.get('/api/docker/containers', (req, res) => {
  exec(`docker ps --format '{{json .}}'`, (error, stdout) => {
    if (error) {
      console.error('[API] docker ps failed:', error.message);
      return res.json([]);
    }
    const containers = stdout.trim().split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean).map(c => {
      const portMatch = (c.Ports || '').match(/(?:0\.0\.0\.0|127\.0\.0\.1|\[::\]):(\d+)->/);
      return { name: c.Names, port: portMatch ? Number(portMatch[1]) : null };
    }).filter(c => c.port); // only containers with a browsable published port
    res.json(containers);
  });
});

// Container health - unhealthy/restarting only, for the right-column widget
app.get('/api/docker/unhealthy', (req, res) => {
  exec(`docker ps -a --format '{{json .}}'`, (error, stdout) => {
    if (error) {
      console.error('[API] docker ps -a failed:', error.message);
      return res.json([]);
    }
    const flagged = stdout.trim().split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean).filter(c => /unhealthy|restarting/i.test(c.Status || ''))
      .map(c => ({ name: c.Names, status: c.Status }));
    res.json(flagged);
  });
});

// Active downloads - merges NZBget (usenet) and qBittorrent-via-qui (torrents)
app.get('/api/downloads/active', async (req, res) => {
  const results = [];
  const { nzbget, qui } = config.integrations || {};

  if (nzbget) {
    try {
      const url = `http://${nzbget.username}:${nzbget.password}@${nzbget.url.replace(/^https?:\/\//, '')}`;
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'listgroups', params: [] }),
      });
      const data = await r.json();
      (data.result || []).filter(g => g.Status === 'DOWNLOADING').forEach(g => {
        const totalMB = g.FileSizeMB || 0;
        const remainMB = g.RemainingSizeMB || 0;
        results.push({
          source: 'nzbget',
          name: g.NZBName,
          progress: totalMB ? Math.round(((totalMB - remainMB) / totalMB) * 100) : 0,
        });
      });
    } catch (err) {
      console.error('[API] NZBget fetch failed:', err.message);
    }
  }

  if (qui) {
    try {
      const r = await fetch(`${qui.url}/api/instances/${qui.instance_id}/torrents`, {
        headers: { 'X-API-Key': qui.api_key },
      });
      const data = await r.json();
      const active = new Set(['downloading', 'metaDL', 'forcedDL']);
      (data.torrents || []).filter(t => active.has(t.state)).forEach(t => {
        results.push({ source: 'qbittorrent', name: t.name, progress: Math.round((t.progress || 0) * 100) });
      });
    } catch (err) {
      console.error('[API] qui fetch failed:', err.message);
    }
  }

  res.json(results);
});

// Recently added media - Jellyfin + Immich, normalized
app.get('/api/media/recent', async (req, res) => {
  const results = [];
  const { jellyfin, immich } = config.integrations || {};

  if (jellyfin) {
    try {
      const r = await fetch(
        `${jellyfin.url}/Items?SortBy=DateCreated&SortOrder=Descending&Limit=9&Recursive=true&IncludeItemTypes=Movie,Series,Episode`,
        { headers: { 'X-Emby-Token': jellyfin.token } }
      );
      const data = await r.json();
      (data.Items || []).forEach(item => {
        // Episodes use their parent show's poster, not the episode's own
        // still-frame thumbnail - matches how Jellyfin's own UI treats them
        const imageId = item.Type === 'Episode' ? item.SeriesId : item.Id;
        if (!imageId) return;
        if (item.Type !== 'Episode' && !item.ImageTags?.Primary) return;
        results.push({
          source: 'jellyfin',
          id: item.Id,
          title: item.Name,
          type: item.Type, // Movie | Series | Episode
          episodeCode: item.Type === 'Episode' && item.ParentIndexNumber != null && item.IndexNumber != null
            ? `S${item.ParentIndexNumber}E${item.IndexNumber}` : null,
          thumbUrl: `/api/media/thumb/jellyfin/${imageId}`,
          linkUrl: `${jellyfin.public_url || jellyfin.url}/web/index.html#/details?id=${item.Id}&serverId=${item.ServerId}`,
        });
      });
    } catch (err) {
      console.error('[API] Jellyfin fetch failed:', err.message);
    }
  }

  if (immich) {
    try {
      const r = await fetch(`${immich.url}/api/search/metadata`, {
        method: 'POST',
        headers: { 'x-api-key': immich.api_key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ size: 9 }),
      });
      const data = await r.json();
      (data.assets?.items || []).forEach(asset => {
        results.push({
          source: 'immich',
          id: asset.id,
          title: asset.originalFileName,
          type: asset.type === 'VIDEO' ? 'Video' : 'Photo',
          thumbUrl: `/api/media/thumb/immich/${asset.id}`,
          linkUrl: `${immich.public_url || immich.url}/photos/${asset.id}`,
        });
      });
    } catch (err) {
      console.error('[API] Immich fetch failed:', err.message);
    }
  }

  res.json(results);
});

// Thumbnail proxy - keeps Jellyfin/Immich API keys server-side only
app.get('/api/media/thumb/:source/:id', async (req, res) => {
  const { source, id } = req.params;
  const { jellyfin, immich } = config.integrations || {};
  try {
    let upstream;
    if (source === 'jellyfin' && jellyfin) {
      upstream = await fetch(`${jellyfin.url}/Items/${id}/Images/Primary?maxWidth=200`, { headers: { 'X-Emby-Token': jellyfin.token } });
    } else if (source === 'immich' && immich) {
      upstream = await fetch(`${immich.url}/api/assets/${id}/thumbnail`, { headers: { 'x-api-key': immich.api_key } });
    } else {
      return res.status(404).end();
    }
    res.set('Content-Type', upstream.headers.get('content-type') || 'image/jpeg');
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.send(buf);
  } catch (err) {
    console.error('[API] Thumbnail proxy failed:', err.message);
    res.status(502).end();
  }
});

// System Monitor Info
let cachedDisk = null;
let cachedOsInfo = null;
let lastHeavyStatsTime = 0;

app.get('/api/system/stats', async (req, res) => {
  try {
    const cpuLoad = await si.currentLoad();
    const memory = await si.mem();

    const now = Date.now();
    if (now - lastHeavyStatsTime > 60000 || !cachedDisk) {
      cachedDisk = await si.fsSize();
      cachedOsInfo = await si.osInfo();
      lastHeavyStatsTime = now;
    }

    res.json({
      cpu: { load: cpuLoad.currentLoad, cores: cpuLoad.cpus.map(c => c.load) },
      memory: { total: memory.total, active: memory.active, usedPercent: (memory.active / memory.total) * 100 },
      disk: cachedDisk.filter(d => d.mount === '/' || d.mount.startsWith('/srv/') || d.mount.startsWith('/mnt/')).map(d => ({
        fs: d.fs, size: d.size, use: d.use, mount: d.mount,
      })),
      os: {
        platform: cachedOsInfo.platform, distro: cachedOsInfo.distro, release: cachedOsInfo.release,
        hostname: cachedOsInfo.hostname, uptime: si.time().uptime,
      },
    });
  } catch (err) {
    console.error('System Info fetch failed:', err);
    res.status(500).json({ error: 'Failed to fetch system information' });
  }
});

// Randomize background from rclone
async function randomizeBackground() {
  const { rclone_remote: remote, rclone_path: remotePath } = config.background || {};
  if (!remote) {
    return Promise.reject(new Error('background.rclone_remote not configured - skipping background rotation'));
  }
  const remoteBase = `${remote}:${remotePath || ''}`;
  const remoteJoin = (file) => remotePath ? `${remoteBase}/${file}` : `${remoteBase}${file}`;

  return new Promise((resolve, reject) => {
    console.log('[Server] Querying rclone backgrounds list...');
    exec(`rclone lsf "${remoteBase}"`, (err, stdout) => {
      if (err) {
        console.error('[Server] Failed to list rclone wallpapers:', err);
        return reject(err);
      }
      const files = stdout.split('\n').map(f => f.trim()).filter(f => {
        if (!f) return false;
        return ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(path.extname(f).toLowerCase());
      });
      if (files.length === 0) return reject(new Error('No images found'));

      const randomFile = files[Math.floor(Math.random() * files.length)];
      console.log(`[Server] Selected random background: ${randomFile}`);
      const destPath = path.join(__dirname, 'public', 'background.jpg');

      exec(`rclone copyto "${remoteJoin(randomFile)}" "${destPath}"`, (copyErr) => {
        if (copyErr) {
          console.error('[Server] Failed to copy background via rclone:', copyErr);
          return reject(copyErr);
        }
        console.log('[Server] Successfully downloaded and cached new background.');
        broadcastEvent('background_change', { filename: randomFile });
        resolve(randomFile);
      });
    });
  });
}

app.post('/api/background/randomize', async (req, res) => {
  try {
    const filename = await randomizeBackground();
    res.json({ success: true, filename });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// SSE for live config/background updates
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.write(`data: ${JSON.stringify({ type: 'connected', time: new Date() })}\n\n`);

  sseClients.add(res);
  console.log(`[SSE] Client connected. Total clients: ${sseClients.size}`);
  req.on('close', () => {
    sseClients.delete(res);
    console.log(`[SSE] Client disconnected. Total clients: ${sseClients.size}`);
  });
});

// Start Server
const PORT = config.server.port || 4848;
const HOST = config.server.host || 'localhost';

app.listen(PORT, HOST, () => {
  console.log(`[Server] Dashboard listening on http://${HOST}:${PORT}`);
  randomizeBackground().catch(err => console.error('[Server] Initial background fetch failed:', err.message));
});
