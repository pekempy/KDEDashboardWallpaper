import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { exec, execFile } from 'child_process';
import si from 'systeminformation';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

process.env.TERM = process.env.TERM || 'xterm-256color';

// .env holds PUBLIC_API_TOKEN (see README "Public API") - optional, so a
// fresh clone with no .env just runs without that feature.
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch {}

const app = express();
app.use(cors());
app.get('/api/display', (req, res) => {
  res.json(config.display || {});
});
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
    if (!config.dockhand) config.dockhand = {};
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
function getDockerContainers() {
  return new Promise((resolve) => {
    exec(`docker ps --format '{{json .}}'`, (error, stdout) => {
      if (error) {
        console.error('[API] docker ps failed:', error.message);
        return resolve([]);
      }
      const containers = stdout.trim().split('\n').filter(Boolean).map(line => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean).map(c => {
        const portMatch = (c.Ports || '').match(/(?:0\.0\.0\.0|127\.0\.0\.1|\[::\]):(\d+)->/);
        return { name: c.Names, port: portMatch ? Number(portMatch[1]) : null };
      }).filter(c => c.port); // only containers with a browsable published port
      resolve(containers);
    });
  });
}
app.get('/api/docker/containers', async (req, res) => {
  res.json(await getDockerContainers());
});

// Container health - unhealthy/restarting only, for the right-column widget
function getUnhealthyContainers() {
  return new Promise((resolve) => {
    exec(`docker ps -a --format '{{json .}}'`, (error, stdout) => {
      if (error) {
        console.error('[API] docker ps -a failed:', error.message);
        return resolve([]);
      }
      const flagged = stdout.trim().split('\n').filter(Boolean).map(line => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean).filter(c => /unhealthy|restarting/i.test(c.Status || ''))
        .map(c => ({ name: c.Names, status: c.Status }));
      resolve(flagged);
    });
  });
}
app.get('/api/docker/unhealthy', async (req, res) => {
  res.json(await getUnhealthyContainers());
});

// Docker prints --timestamps as full RFC3339Nano (2026-08-21T07:08:47.587360692Z) -
// nine digits of sub-second precision and a date nobody reading a log widget needs. Trim to "HH:MM:SS".
function trimLogTimestamps(text) {
  return text.replace(/^\d{4}-\d{2}-\d{2}T(\d{2}:\d{2}:\d{2})\.\d+Z/gm, '$1');
}

// Docker logs for one container - used by the unhealthy-widget's log modal.
// execFile (not exec) so the name is passed as a real argv entry, never through a shell.
app.get('/api/docker/logs/:name', (req, res) => {
  const { name } = req.params;
  execFile('docker', ['logs', '--tail', '400', '--timestamps', name], { maxBuffer: 5 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error && !stdout && !stderr) {
      console.error(`[API] docker logs failed for ${name}:`, error.message);
      return res.status(500).json({ error: error.message });
    }
    res.json({ logs: trimLogTimestamps(`${stdout}${stderr}`) || '(no log output)' });
  });
});

// Active downloads - merges NZBget (usenet) and qBittorrent-via-qui (torrents)
async function getDownloadsActive() {
  const results = [];
  const { nzbget, qui } = config.integrations || {};

  if (nzbget) {
    try {
      // Basic auth via header - Node's fetch rejects credentials in the URL.
      const auth = Buffer.from(`${nzbget.username}:${nzbget.password}`).toString('base64');
      const r = await fetch(nzbget.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
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

  return results;
}

app.get('/api/downloads/active', async (req, res) => {
  res.json(await getDownloadsActive());
});

// Recently added media - Jellyfin + Immich, normalized
async function getMediaRecent() {
  const results = [];
  const { jellyfin, immich } = config.integrations || {};

  if (jellyfin) {
    try {
      const r = await fetch(
        `${jellyfin.url}/Items?SortBy=DateCreated&SortOrder=Descending&Limit=9&Recursive=true&IncludeItemTypes=Movie,Series,Episode&Fields=DateCreated`,
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
          addedAt: item.DateCreated,
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
          addedAt: asset.fileCreatedAt || asset.localDateTime,
        });
      });
    } catch (err) {
      console.error('[API] Immich fetch failed:', err.message);
    }
  }

  // Interleave both sources by actual timestamp instead of the previous
  // "9 jellyfin then 9 immich" block order, so the grid reads as one
  // real-world-chronological feed.
  results.sort((a, b) => new Date(b.addedAt || 0) - new Date(a.addedAt || 0));

  return results;
}

app.get('/api/media/recent', async (req, res) => {
  res.json(await getMediaRecent());
});

// Shared by both the internal (/api/media/*) and public (/api/public/media/*)
// routes below, so the fetch-and-buffer logic only lives in one place.
async function fetchThumbnailBuffer(source, id) {
  const { jellyfin, immich } = config.integrations || {};
  let upstream;
  if (source === 'jellyfin' && jellyfin) {
    upstream = await fetch(`${jellyfin.url}/Items/${id}/Images/Primary?maxWidth=200`, { headers: { 'X-Emby-Token': jellyfin.token } });
  } else if (source === 'jellyfin-user' && jellyfin) {
    upstream = await fetch(`${jellyfin.url}/Users/${id}/Images/Primary?maxWidth=100`, { headers: { 'X-Emby-Token': jellyfin.token } });
  } else if (source === 'immich' && immich) {
    upstream = await fetch(`${immich.url}/api/assets/${id}/thumbnail`, { headers: { 'x-api-key': immich.api_key } });
  } else {
    return null;
  }
  if (!upstream.ok) return null;
  return { contentType: upstream.headers.get('content-type') || 'image/jpeg', buffer: Buffer.from(await upstream.arrayBuffer()) };
}

// Plex images (posters/backdrops) live at server-relative paths (e.g.
// /library/metadata/123/thumb/456) that need the Plex token appended.
async function fetchPlexImageBuffer(thumbPath) {
  const { plex } = config.integrations || {};
  if (!plex || !thumbPath || !thumbPath.startsWith('/')) return null;
  const upstream = await fetch(`${plex.url}${thumbPath}`, { headers: { 'X-Plex-Token': plex.token } });
  if (!upstream.ok) return null;
  return { contentType: upstream.headers.get('content-type') || 'image/jpeg', buffer: Buffer.from(await upstream.arrayBuffer()) };
}

// Thumbnail proxy - keeps Jellyfin/Immich API keys server-side only
app.get('/api/media/thumb/:source/:id', async (req, res) => {
  try {
    const result = await fetchThumbnailBuffer(req.params.source, req.params.id);
    if (!result) return res.status(404).end();
    res.set('Content-Type', result.contentType);
    res.send(result.buffer);
  } catch (err) {
    console.error('[API] Thumbnail proxy failed:', err.message);
    res.status(502).end();
  }
});

app.get('/api/media/plex-image', async (req, res) => {
  try {
    const result = await fetchPlexImageBuffer(req.query.path);
    if (!result) return res.status(404).end();
    res.set('Content-Type', result.contentType);
    res.send(result.buffer);
  } catch (err) {
    console.error('[API] Plex image proxy failed:', err.message);
    res.status(502).end();
  }
});

// Live "now playing" sessions - Jellyfin + Plex, normalized into one shape
// so the frontend widget doesn't need to know which backend a stream came
// from. Each item carries enough for both the compact row (user, title,
// transcode flag, progress) and the stream-details popout (codecs,
// resolution, bitrate, why a transcode is happening).
async function fetchJellyfinNowPlaying(jellyfin) {
  try {
    const r = await fetch(`${jellyfin.url}/Sessions`, { headers: { 'X-Emby-Token': jellyfin.token } });
    const sessions = await r.json();
    return (sessions || []).filter(s => s.NowPlayingItem).map(s => {
      const item = s.NowPlayingItem;
      const playState = s.PlayState || {};
      const tc = s.TranscodingInfo;
      // Episodes use their parent show's poster, matching the Recently Added grid
      const posterId = item.Type === 'Episode' ? (item.SeriesId || item.Id) : item.Id;
      const progressPercent = item.RunTimeTicks
        ? Math.round(((playState.PositionTicks || 0) / item.RunTimeTicks) * 100) : 0;
      // Ticks are 100ns units - /10000 gives ms. Start/end are estimates from
      // current position, not a real recorded playback-start event.
      const positionMs = (playState.PositionTicks || 0) / 10000;
      const totalMs = item.RunTimeTicks ? item.RunTimeTicks / 10000 : null;
      const now = Date.now();
      const startedAt = new Date(now - positionMs).toISOString();
      const endsAt = (!playState.IsPaused && totalMs != null) ? new Date(now + (totalMs - positionMs)).toISOString() : null;
      const subtitle = item.Type === 'Episode'
        ? [item.ParentIndexNumber != null && item.IndexNumber != null ? `S${item.ParentIndexNumber}E${item.IndexNumber}` : null, item.SeriesName].filter(Boolean).join(' · ')
        : (item.ProductionYear ? String(item.ProductionYear) : null);
      const videoStream = item.MediaStreams?.find(m => m.Type === 'Video');
      const audioStream = item.MediaStreams?.find(m => m.Type === 'Audio');
      return {
        source: 'jellyfin',
        sessionId: s.Id,
        user: { name: s.UserName || 'Unknown', avatarUrl: s.UserId ? `/api/media/thumb/jellyfin-user/${s.UserId}` : null },
        title: item.Name,
        subtitle,
        type: item.Type,
        posterUrl: posterId ? `/api/media/thumb/jellyfin/${posterId}` : null,
        progressPercent,
        startedAt,
        endsAt,
        state: playState.IsPaused ? 'paused' : 'playing',
        transcoding: playState.PlayMethod === 'Transcode',
        playMethod: playState.PlayMethod === 'Transcode' ? 'Transcode'
          : playState.PlayMethod === 'DirectStream' ? 'Direct Stream' : 'Direct Play',
        device: s.DeviceName,
        client: s.Client,
        quality: {
          resolution: tc ? `${tc.Width || '?'}x${tc.Height || '?'}` : (videoStream ? `${videoStream.Width}x${videoStream.Height}` : null),
          videoCodec: (tc?.VideoCodec || videoStream?.Codec || '').toUpperCase() || null,
          audioCodec: (tc?.AudioCodec || audioStream?.Codec || '').toUpperCase() || null,
          bitrate: tc?.Bitrate ? Math.round(tc.Bitrate / 1000)
            : (item.MediaSources?.[0]?.Bitrate ? Math.round(item.MediaSources[0].Bitrate / 1000)
            : (Math.round(((videoStream?.BitRate || 0) + (audioStream?.BitRate || 0)) / 1000) || null)),
          // Direct-play sessions report Item.Container as a comma-separated list of
          // compatible extensions (e.g. "mov,mp4,m4a") rather than the actual file's
          // container - only the first entry reflects what's actually playing.
          container: (tc?.Container || item.Container || '').split(',')[0].toUpperCase() || null,
        },
        details: {
          videoDecision: tc ? (tc.IsVideoDirect ? 'Direct' : 'Transcode') : 'Direct',
          audioDecision: tc ? (tc.IsAudioDirect ? 'Direct' : 'Transcode') : 'Direct',
          reasons: tc?.TranscodeReasons || [],
        },
      };
    });
  } catch (err) {
    console.error('[API] Jellyfin sessions fetch failed:', err.message);
    return [];
  }
}

async function fetchPlexNowPlaying(plex) {
  try {
    const r = await fetch(`${plex.url}/status/sessions`, { headers: { 'X-Plex-Token': plex.token, Accept: 'application/json' } });
    const data = await r.json();
    const items = data.MediaContainer?.Metadata || [];
    return items.map(item => {
      const media = item.Media?.[0];
      const part = media?.Part?.[0];
      const ts = item.TranscodeSession;
      const isEpisode = item.type === 'episode';
      const subtitle = isEpisode
        ? [item.parentIndex != null && item.index != null ? `S${item.parentIndex}E${item.index}` : null, item.grandparentTitle].filter(Boolean).join(' · ')
        : (item.year ? String(item.year) : null);
      // Episodes use their parent show's poster, matching the Recently Added grid
      const thumbPath = isEpisode ? (item.grandparentThumb || item.thumb) : item.thumb;
      const progressPercent = item.duration ? Math.round(((item.viewOffset || 0) / item.duration) * 100) : 0;
      const videoTranscoding = ts ? ts.videoDecision === 'transcode' : part?.decision === 'transcode';
      const audioTranscoding = ts ? ts.audioDecision === 'transcode' : false;
      // viewOffset/duration are already ms - start/end are estimates from
      // current position, not a real recorded playback-start event.
      const isPaused = item.Player?.state === 'paused';
      const viewOffset = item.viewOffset || 0;
      const now = Date.now();
      const startedAt = new Date(now - viewOffset).toISOString();
      const endsAt = (!isPaused && item.duration) ? new Date(now + (item.duration - viewOffset)).toISOString() : null;
      return {
        source: 'plex',
        sessionId: item.sessionKey,
        user: { name: item.User?.title || 'Unknown', avatarUrl: item.User?.thumb || null },
        title: item.title,
        subtitle,
        type: item.type,
        posterUrl: thumbPath ? `/api/media/plex-image?path=${encodeURIComponent(thumbPath)}` : null,
        progressPercent,
        startedAt,
        endsAt,
        state: isPaused ? 'paused' : 'playing',
        transcoding: !!(videoTranscoding || audioTranscoding),
        playMethod: ts ? 'Transcode' : (part?.decision === 'copy' ? 'Direct Stream' : 'Direct Play'),
        device: item.Player?.title,
        client: item.Player?.product,
        quality: {
          resolution: media?.videoResolution ? (/^\d+$/.test(media.videoResolution) ? `${media.videoResolution}p` : media.videoResolution.toUpperCase()) : null,
          videoCodec: media?.videoCodec ? media.videoCodec.toUpperCase() : null,
          audioCodec: media?.audioCodec ? media.audioCodec.toUpperCase() : null,
          bitrate: ts?.bitrate || media?.bitrate || null,
          container: media?.container ? media.container.toUpperCase() : null,
        },
        details: {
          videoDecision: videoTranscoding ? 'Transcode' : 'Direct',
          audioDecision: audioTranscoding ? 'Transcode' : 'Direct',
          reasons: ts ? [
            ts.videoDecision === 'transcode' ? `Video: ${ts.sourceVideoCodec || '?'} → ${ts.videoCodec || '?'}` : null,
            ts.audioDecision === 'transcode' ? `Audio: ${ts.sourceAudioCodec || '?'} → ${ts.audioCodec || '?'}` : null,
          ].filter(Boolean) : [],
        },
      };
    });
  } catch (err) {
    console.error('[API] Plex sessions fetch failed:', err.message);
    return [];
  }
}

async function getNowPlaying() {
  const { jellyfin, plex } = config.integrations || {};
  const results = [];
  if (jellyfin) results.push(...await fetchJellyfinNowPlaying(jellyfin));
  if (plex) results.push(...await fetchPlexNowPlaying(plex));
  return results;
}

app.get('/api/media/nowplaying', async (req, res) => {
  res.json(await getNowPlaying());
});

// System Monitor Info
let cachedDisk = null;
let cachedOsInfo = null;
let lastHeavyStatsTime = 0;

async function getSystemStats() {
  const cpuLoad = await si.currentLoad();
  const memory = await si.mem();

  const now = Date.now();
  if (now - lastHeavyStatsTime > 60000 || !cachedDisk) {
    cachedDisk = await si.fsSize();
    cachedOsInfo = await si.osInfo();
    lastHeavyStatsTime = now;
  }

  return {
    cpu: { load: cpuLoad.currentLoad, cores: cpuLoad.cpus.map(c => c.load) },
    memory: { total: memory.total, active: memory.active, usedPercent: (memory.active / memory.total) * 100 },
    disk: cachedDisk.filter(d => d.mount === '/' || d.mount.startsWith('/srv/') || d.mount.startsWith('/mnt/')).map(d => ({
      fs: d.fs, size: d.size, use: d.use, mount: d.mount,
    })),
    os: {
      platform: cachedOsInfo.platform, distro: cachedOsInfo.distro, release: cachedOsInfo.release,
      hostname: cachedOsInfo.hostname, uptime: si.time().uptime,
    },
  };
}

app.get('/api/system/stats', async (req, res) => {
  try {
    res.json(await getSystemStats());
  } catch (err) {
    console.error('System Info fetch failed:', err);
    res.status(500).json({ error: 'Failed to fetch system information' });
  }
});

// ----------------------------------------------------------------------
// Public API - everything this dashboard knows, as one JSON blob, for an
// external client (e.g. a phone-widget build of this same dashboard) to
// pull over the internet and pick whatever fields it wants out of. Gated
// entirely behind PUBLIC_API_TOKEN (see .env.example) - unset means this
// whole namespace 404s, so a fresh clone has it off by default. Never put
// the command/URL-launch or config-writing routes behind this: those are
// remote-control endpoints, not read-only stats, and must stay local-only.
// ----------------------------------------------------------------------
function timingSafeStringEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function requirePublicApiToken(req, res, next) {
  const configured = process.env.PUBLIC_API_TOKEN;
  if (!configured) return res.status(404).end();
  const header = req.get('authorization') || '';
  const supplied = header.replace(/^Bearer\s+/i, '') || req.query.token || '';
  if (!supplied || !timingSafeStringEqual(supplied, configured)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.use('/api/public', requirePublicApiToken);

// Every internal-proxy URL these functions hand back (thumbUrl, posterUrl,
// user.avatarUrl) is rooted at /api/media/... - rewrite to the /api/public/
// mirror below so an external client never needs the un-authenticated path.
function rewritePublicMediaUrls(value) {
  if (Array.isArray(value)) return value.map(rewritePublicMediaUrls);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = rewritePublicMediaUrls(v);
    return out;
  }
  if (typeof value === 'string' && value.startsWith('/api/media/')) {
    return value.replace('/api/media/', '/api/public/media/');
  }
  return value;
}

app.get('/api/public/dashboard', async (req, res) => {
  try {
    const [system, nowPlaying, mediaRecent, downloads, containers, unhealthy] = await Promise.all([
      getSystemStats(),
      getNowPlaying(),
      getMediaRecent(),
      getDownloadsActive(),
      getDockerContainers(),
      getUnhealthyContainers(),
    ]);
    res.json(rewritePublicMediaUrls({
      generatedAt: new Date().toISOString(),
      system,
      nowPlaying,
      mediaRecent,
      downloads,
      docker: { containers, unhealthy },
    }));
  } catch (err) {
    console.error('[API] Public dashboard aggregate failed:', err.message);
    res.status(500).json({ error: 'Failed to build dashboard payload' });
  }
});

app.get('/api/public/media/thumb/:source/:id', async (req, res) => {
  try {
    const result = await fetchThumbnailBuffer(req.params.source, req.params.id);
    if (!result) return res.status(404).end();
    res.set('Content-Type', result.contentType);
    res.send(result.buffer);
  } catch (err) {
    console.error('[API] Public thumbnail proxy failed:', err.message);
    res.status(502).end();
  }
});

app.get('/api/public/media/plex-image', async (req, res) => {
  try {
    const result = await fetchPlexImageBuffer(req.query.path);
    if (!result) return res.status(404).end();
    res.set('Content-Type', result.contentType);
    res.send(result.buffer);
  } catch (err) {
    console.error('[API] Public plex image proxy failed:', err.message);
    res.status(502).end();
  }
});

// Randomize background from rclone
async function randomizeBackground() {
  const { rclone_remote: remote, rclone_path: remotePath } = config.background || {};
  if (!remote) {
    console.error('[Server] background.rclone_remote NOT FOUND in config:', config.background);
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
