import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { spawn, exec } from 'child_process';
import net from 'net';
import si from 'systeminformation';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure TERM environment variable is set for spawned subprocesses
process.env.TERM = process.env.TERM || 'xterm-256color';

const app = express();
app.use(cors());
app.use(express.json());

// Serve static assets from public folder
app.use(express.static(path.join(__dirname, 'public')));

// Paths to configurations
const CONFIG_PATH = path.join(__dirname, 'config.yaml');
const PROJECTS_PATH = path.join(__dirname, 'projects.yaml');
const DOCKER_PATH = path.join(__dirname, 'docker.yaml');

let config = null;
let projectsList = [];
let dockerList = [];

// Save lists back to files
function saveProjects() {
  fs.writeFileSync(PROJECTS_PATH, yaml.dump(projectsList), 'utf8');
}

function saveDocker() {
  fs.writeFileSync(DOCKER_PATH, yaml.dump(dockerList), 'utf8');
}

function saveConfig() {
  fs.writeFileSync(CONFIG_PATH, yaml.dump(config), 'utf8');
}

// Parse Caddyfile to extract host mappings for docker containers
function parseCaddyfile() {
  const caddyfilePath = '/srv/docker/caddy/Caddyfile';
  if (!fs.existsSync(caddyfilePath)) {
    console.warn(`[Caddy Parser] Caddyfile not found at ${caddyfilePath}`);
    return {};
  }
  
  try {
    const content = fs.readFileSync(caddyfilePath, 'utf8');
    const lines = content.split('\n');
    const mappings = {};
    
    let currentDomains = [];
    
    for (let i = 0; i < lines.length; i++) {
      const lineRaw = lines[i];
      const line = lineRaw.trim();
      if (!line || line.startsWith('#')) continue;
      
      // Check if line defines a root block start with domain names (column 0)
      if (lineRaw.trimEnd().endsWith('{') && !/^\s/.test(lineRaw)) {
        const domainPart = line.substring(0, line.length - 1).trim();
        if (domainPart && !domainPart.startsWith('(') && domainPart !== '{') {
          currentDomains = domainPart.split(',').map(d => d.trim()).filter(Boolean);
        }
        continue;
      }
      
      // Look for reverse_proxy container:port
      if (line.startsWith('reverse_proxy')) {
        const parts = line.split(/\s+/);
        const upstream = parts[1];
        if (upstream && currentDomains.length > 0) {
          const cleanUpstream = upstream.replace(/^https?:\/\//, '');
          const hostPort = cleanUpstream.split(':')[0]; // get container name (e.g. 'authentik')
          
          // Find the best domain (prefer glados.host over others, e.g. troubledmind.trade)
          let bestDomain = currentDomains[0];
          const gladosDomain = currentDomains.find(d => d.includes('glados.host'));
          if (gladosDomain) {
            bestDomain = gladosDomain;
          }
          
          // Only map if not mapped, or if we found a better one (like glados.host over troubledmind.trade)
          if (!mappings[hostPort] || bestDomain.includes('glados.host')) {
            const scheme = bestDomain.includes('glados.host') ? 'https://' : 'http://';
            mappings[hostPort] = scheme + bestDomain;
          }
        }
      }
      
      if (line === '}' && !/^\s/.test(lineRaw)) {
        currentDomains = [];
      }
    }
    
    return mappings;
  } catch (err) {
    console.error('[Caddy Parser] Failed to parse Caddyfile:', err);
    return {};
  }
}

// Get stacks mapping from Dockhand
function getDockerStacks() {
  const stacksDir = '/srv/docker/dockhand/data/stacks/GLaDOS';
  const mapping = {};
  const stacks = [];
  
  if (!fs.existsSync(stacksDir)) {
    return { mapping, stacks };
  }
  
  try {
    const files = fs.readdirSync(stacksDir);
    for (const file of files) {
      const fullPath = path.join(stacksDir, file);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        const stackName = file;
        stacks.push(stackName);
        
        const composeFiles = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];
        for (const cf of composeFiles) {
          const cp = path.join(fullPath, cf);
          if (fs.existsSync(cp)) {
            try {
              const content = fs.readFileSync(cp, 'utf8');
              const doc = yaml.load(content);
              if (doc && doc.services) {
                Object.keys(doc.services).forEach(serviceKey => {
                  const service = doc.services[serviceKey];
                  const containerName = service.container_name || serviceKey;
                  mapping[containerName] = stackName;
                });
              }
            } catch (err) {
              try {
                // regex fallback
                const content = fs.readFileSync(cp, 'utf8');
                const lines = content.split('\n');
                lines.forEach(line => {
                  const trimmed = line.trim();
                  if (trimmed.startsWith('container_name:')) {
                    const name = trimmed.replace('container_name:', '').trim().replace(/['"]/g, '');
                    if (name) mapping[name] = stackName;
                  }
                });
              } catch (e) {}
            }
          }
        }
      }
    }
  } catch (err) {
    console.error('[Stacks Parser] Failed to read stacks:', err);
  }
  
  return { mapping, stacks: [...new Set(stacks)].sort() };
}

function broadcastConfigReload() {
  const caddyMappings = parseCaddyfile();
  const dockerStacks = getDockerStacks();
  broadcastEvent('config_reload', {
    ...config,
    projects: projectsList,
    docker: dockerList,
    caddyMappings,
    dockerStacks
  });
}


// Load and parse configuration
function loadConfig() {
  try {
    const fileContents = fs.readFileSync(CONFIG_PATH, 'utf8');
    config = yaml.load(fileContents);
    
    // Defaults
    if (!config.categories) config.categories = [];
    if (!config.quick_links) config.quick_links = [];
    if (!config.bookmarks) config.bookmarks = [];

    // Load projects.yaml
    if (fs.existsSync(PROJECTS_PATH)) {
      const projContents = fs.readFileSync(PROJECTS_PATH, 'utf8');
      projectsList = yaml.load(projContents) || [];
    } else {
      projectsList = [];
    }

    // Load docker.yaml
    if (fs.existsSync(DOCKER_PATH)) {
      const dockerContents = fs.readFileSync(DOCKER_PATH, 'utf8');
      dockerList = yaml.load(dockerContents) || [];
    } else {
      dockerList = [];
    }

    console.log('[Server] Configuration loaded/reloaded.');
    return true;
  } catch (e) {
    console.error('[Server] Failed to load configuration files:', e);
    return false;
  }
}

// Watch configurations for hot reloading
const watchFiles = [CONFIG_PATH, PROJECTS_PATH, DOCKER_PATH];
watchFiles.forEach(filePath => {
  if (fs.existsSync(filePath)) {
    fs.watch(filePath, (eventType, filename) => {
      if (eventType === 'change') {
        console.log(`[Server] ${path.basename(filePath)} changed. Reloading...`);
        loadConfig();
        broadcastConfigReload();
      }
    });
  }
});

// Initial config load
loadConfig();

// Background Service Management
const services = new Map(); // key -> { process, logs, status, startTime, exitCode }

function getServiceKey(projectId, actionName) {
  return `${projectId}:${actionName}`;
}

// Broadcaster for Server-Sent Events (SSE)
const sseClients = new Set();

function broadcastEvent(type, data) {
  const payload = JSON.stringify({ type, data });
  for (const client of sseClients) {
    client.write(`data: ${payload}\n\n`);
  }
}

// Per-service partial-line buffers (for progress bar \r handling)
const serviceLineBuffers = new Map();
// Per-service flags for whether the next line should replace the previous (for progress bar \r handling)
const serviceReplaceFlags = new Map();

// Strip ANSI escape sequences (colors, cursor movement, etc.)
function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b[()][A-Z0-9]/g, '');
}

// Append logs to service buffer and notify listeners.
// Handles \r (carriage-return) for in-place progress bar updates.
function appendServiceLog(key, rawData) {
  const svc = services.get(key);
  if (!svc) return;

  // Combine any previously-buffered partial line with the new chunk
  const buffer = (serviceLineBuffers.get(key) || '') + rawData.toString();

  const linesToEmit = []; // { text, replace }
  let currentLine = '';
  // Restore the replace flag from the previous chunk
  let nextShouldReplace = serviceReplaceFlags.get(key) || false;

  for (let i = 0; i < buffer.length; i++) {
    const ch = buffer[i];
    if (ch === '\r') {
      if (i + 1 < buffer.length && buffer[i + 1] === '\n') {
        // Windows-style \r\n — treat as a normal newline
        linesToEmit.push({ text: currentLine, replace: nextShouldReplace });
        currentLine = '';
        nextShouldReplace = false;
        i++; // consume the \n too
      } else {
        // Bare \r (progress bar) — emit current line and flag the NEXT one as a replacement
        linesToEmit.push({ text: currentLine, replace: nextShouldReplace });
        currentLine = '';
        nextShouldReplace = true; // next emit overwrites the line we just pushed
      }
    } else if (ch === '\n') {
      linesToEmit.push({ text: currentLine, replace: nextShouldReplace });
      currentLine = '';
      nextShouldReplace = false;
    } else {
      currentLine += ch;
    }
  }

  // Save the remaining incomplete line and replace flag for the next data chunk
  serviceLineBuffers.set(key, currentLine);
  serviceReplaceFlags.set(key, nextShouldReplace);

  for (const { text, replace } of linesToEmit) {
    const clean = stripAnsi(text);
    // Skip completely blank separator lines to reduce noise
    if (!clean.trim() && !replace) continue;

    const logLine = { timestamp: new Date().toISOString(), text: clean, replace };

    if (replace && svc.logs.length > 0) {
      // Overwrite the previous entry in place (progress bar behaviour)
      svc.logs[svc.logs.length - 1] = logLine;
    } else {
      svc.logs.push(logLine);
      if (svc.logs.length > 2000) svc.logs.shift();
    }

    broadcastEvent('service_log', { key, log: logLine });
  }
}

// Start a background service
function startService(projectId, action, projectPath) {
  const key = getServiceKey(projectId, action.name);
  
  // If already running, do nothing
  if (services.has(key) && services.get(key).status === 'running') {
    return services.get(key);
  }
  
  console.log(`[Service] Starting: ${key} -> "${action.cmd}" in ${projectPath}`);
  
  // Create state container
  const svcState = {
    projectId,
    actionName: action.name,
    cmd: action.cmd,
    status: 'running',
    startTime: new Date(),
    logs: [],
    port: action.port,
    process: null
  };
  
  services.set(key, svcState);
  
  // Launch detached process group so we can kill all sub-processes together later
  const child = spawn(action.cmd, [], {
    shell: true,
    cwd: projectPath,
    detached: true,
    env: { ...process.env } // Pass environmental variables (like DISPLAY, PATH)
  });
  
  svcState.process = child;
  
  // Capture stdout
  child.stdout.on('data', (data) => {
    appendServiceLog(key, data);
  });
  
  // Capture stderr
  child.stderr.on('data', (data) => {
    appendServiceLog(key, data);
  });
  
  // Handle process termination
  child.on('close', (code) => {
    console.log(`[Service] Exited: ${key} with code ${code}`);
    svcState.status = 'stopped';
    svcState.exitCode = code;
    broadcastEvent('service_status', {
      key,
      status: 'stopped',
      exitCode: code
    });
  });
  
  child.on('error', (err) => {
    console.error(`[Service] Error: ${key}:`, err);
    svcState.status = 'failed';
    appendServiceLog(key, `Process spawn error: ${err.message}`);
    broadcastEvent('service_status', {
      key,
      status: 'failed',
      error: err.message
    });
  });
  
  broadcastEvent('service_status', {
    key,
    status: 'running',
    startTime: svcState.startTime
  });
  
  return svcState;
}

// Stop a background service
function stopService(key) {
  const svc = services.get(key);
  if (!svc || svc.status !== 'running' || !svc.process) {
    return false;
  }

  console.log(`[Service] Stopping: ${key}`);
  try {
    // Kill the entire process group (negative PID kills the process group)
    process.kill(-svc.process.pid, 'SIGTERM');
    // Clean up buffers and flags for this service
    serviceLineBuffers.delete(key);
    serviceReplaceFlags.delete(key);
    return true;
  } catch (err) {
    console.error(`[Service] Error killing process group for ${key}:`, err);
    // Fallback: kill direct process
    try {
      svc.process.kill('SIGTERM');
      // Clean up buffers and flags for this service
      serviceLineBuffers.delete(key);
      serviceReplaceFlags.delete(key);
      return true;
    } catch (err2) {
      console.error(`[Service] Fallback kill failed:`, err2);
      return false;
    }
  }
}

// Check if a port is open
function checkPortStatus(port) {
  return new Promise((resolve) => {
    if (!port) return resolve(false);
    const client = new net.Socket();
    client.setTimeout(1000);
    
    client.once('connect', () => {
      client.destroy();
      resolve(true); // Connected: port is open (something is listening)
    });
    
    client.once('timeout', () => {
      client.destroy();
      resolve(false);
    });
    
    client.once('error', () => {
      client.destroy();
      resolve(false); // Refused or error: port closed
    });
    
    client.connect({ port, host: '127.0.0.1' });
  });
}

// Get Git status
function getGitStatus(projectPath) {
  return new Promise((resolve) => {
    // Execute git status --porcelain to see if dirty
    // and git rev-parse --abbrev-ref HEAD for branch name
    exec('git rev-parse --abbrev-ref HEAD && git status --porcelain', { cwd: projectPath }, (error, stdout, stderr) => {
      if (error) {
        // Not a git repository or git command error
        return resolve({ isGit: false });
      }
      
      const lines = stdout.trim().split('\n');
      const branch = lines[0] || 'unknown';
      const modifiedFiles = lines.slice(1).filter(line => line.trim().length > 0);
      const isDirty = modifiedFiles.length > 0;
      
      resolve({
        isGit: true,
        branch,
        isDirty,
        dirtyCount: modifiedFiles.length,
        modifiedFiles: modifiedFiles.map(file => file.trim())
      });
    });
  });
}

// Check Docker container status
function checkDockerStatus(containerName) {
  return new Promise((resolve) => {
    if (!containerName) return resolve(null);
    exec(`docker inspect --format="{{.State.Running}} {{.State.Status}}" "${containerName}"`, (error, stdout, stderr) => {
      if (error) {
        return resolve({ running: false, status: 'stopped/not found' });
      }
      const parts = stdout.trim().split(' ');
      const running = parts[0] === 'true';
      const status = parts[1] || 'unknown';
      resolve({ running, status });
    });
  });
}

// APIs

// Get config
app.get('/api/config', (req, res) => {
  const caddyMappings = parseCaddyfile();
  const dockerStacks = getDockerStacks();
  res.json({ ...config, projects: projectsList, docker: dockerList, caddyMappings, dockerStacks });
});

// Run immediate command
app.post('/api/action/command', (req, res) => {
  const { cmd, path: projectPath } = req.body;
  if (!cmd || !projectPath) {
    return res.status(400).json({ error: 'Command and Path are required' });
  }

  console.log(`[API] Executing command: "${cmd}" in path: ${projectPath}`);
  
  exec(cmd, { cwd: projectPath, env: { ...process.env } }, (error, stdout, stderr) => {
    if (error) {
      console.error(`[API] Command failed: ${cmd}`, error);
      return res.status(500).json({
        success: false,
        error: error.message,
        stderr: stderr.toString()
      });
    }
    
    res.json({
      success: true,
      stdout: stdout.toString(),
      stderr: stderr.toString()
    });
  });
});

// Run command with live output streamed through the SSE log system (one-shot "stream" type)
app.post('/api/action/stream', (req, res) => {
  const { projectId, actionName, cmd, path: projectPath } = req.body;
  if (!cmd || !projectPath || !projectId || !actionName) {
    return res.status(400).json({ error: 'projectId, actionName, cmd and path are required' });
  }

  const key = getServiceKey(projectId, actionName);

  // Reset/init the service log slot so the drawer always sees a fresh run
  services.set(key, {
    projectId,
    actionName,
    cmd,
    status: 'running',
    startTime: new Date(),
    logs: [],
    process: null
  });

  broadcastEvent('service_status', { key, status: 'running', startTime: new Date() });

  console.log(`[API/Stream] Spawning: "${cmd}" in ${projectPath}`);

  const child = spawn(cmd, [], {
    shell: true,
    cwd: projectPath,
    env: { ...process.env }
  });

  services.get(key).process = child;

  child.stdout.on('data', (data) => appendServiceLog(key, data));
  child.stderr.on('data', (data) => appendServiceLog(key, data));

  child.on('close', (code) => {
    const svc = services.get(key);
    if (svc) {
      svc.status = 'stopped';
      svc.exitCode = code;
    }
    appendServiceLog(key, `\n--- Process exited with code ${code} ---`);
    broadcastEvent('service_status', { key, status: 'stopped', exitCode: code });
  });

  child.on('error', (err) => {
    appendServiceLog(key, `Process error: ${err.message}`);
    broadcastEvent('service_status', { key, status: 'failed', error: err.message });
  });

  res.json({ success: true, key });
});

// Launch url using desktop Zen Browser flatpak only (no fallback)
app.post('/api/action/url', (req, res) => {
  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  console.log(`[API] Opening URL on host via Zen Browser (Flatpak): ${url}`);
  const zenCmd = `/usr/bin/flatpak run --branch=stable --arch=x86_64 --command=launch-script.sh --file-forwarding app.zen_browser.zen @@u "${url}" @@`;
  
  exec(zenCmd, (error) => {
    if (error) {
      console.warn(`[API] Failed to open URL via Zen Browser:`, error.message);
      return res.json({ success: false, hostOpenFailed: true, error: error.message });
    } else {
      res.json({ success: true });
    }
  });
});

// Service Actions (Start / Stop / Logs)
app.post('/api/service/start', (req, res) => {
  const { projectId, actionName } = req.body;
  const project = [...projectsList, ...dockerList].find(p => p.id === projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  
  const action = project.actions.find(a => a.name === actionName && a.type === 'service');
  if (!action) return res.status(404).json({ error: 'Service action not found' });
  
  const svcState = startService(projectId, action, project.path);
  res.json({
    success: true,
    status: svcState.status,
    key: getServiceKey(projectId, actionName)
  });
});

app.post('/api/service/stop', (req, res) => {
  const { projectId, actionName } = req.body;
  const key = getServiceKey(projectId, actionName);
  
  const stopped = stopService(key);
  res.json({ success: stopped });
});

app.get('/api/service/logs', (req, res) => {
  const { projectId, actionName } = req.query;
  const key = getServiceKey(projectId, actionName);
  
  const svc = services.get(key);
  if (!svc) {
    return res.json({ logs: [] });
  }
  res.json({ logs: svc.logs });
});

// Get Project Details and status (git, ports, services)
app.get('/api/projects/status', async (req, res) => {
  const statusList = [];
  const allProjects = [...projectsList, ...dockerList];
  
  for (const project of allProjects) {
    const projStatus = {
      id: project.id,
      git: null,
      ports: {},
      services: {},
      docker: null
    };
    
    // Check Git status
    if (project.status && project.status.git) {
      projStatus.git = await getGitStatus(project.path);
    }
    
    // Check Docker status
    if (project.status && project.status.docker) {
      projStatus.docker = await checkDockerStatus(project.status.docker);
    }
    
    // Check Port status
    if (project.status && project.status.port) {
      const port = project.status.port;
      const isOpen = await checkPortStatus(port);
      projStatus.ports[port] = isOpen;
    }
    
    // Check ports for service actions
    for (const action of project.actions) {
      if (action.type === 'service' && action.port) {
        const isOpen = await checkPortStatus(action.port);
        projStatus.ports[action.port] = isOpen;
      }
      
      if (action.type === 'service') {
        const key = getServiceKey(project.id, action.name);
        const svc = services.get(key);
        projStatus.services[action.name] = svc ? {
          status: svc.status,
          startTime: svc.startTime,
          exitCode: svc.exitCode
        } : {
          status: 'stopped'
        };
      }
    }
    
    statusList.push(projStatus);
  }
  
  res.json(statusList);
});

// Update UI elements (icons, labels, titles, descriptions)
app.post('/api/ui/update', (req, res) => {
  const { type, id, index, properties } = req.body;
  if (!properties) {
    return res.status(400).json({ error: 'Missing properties to update' });
  }

  if (type === 'title') {
    if (config.ui) {
      config.ui.title = properties.title;
      saveConfig();
      loadConfig();
      broadcastConfigReload();
      return res.json({ success: true });
    }
  }

  if (type === 'category') {
    const cat = config.categories?.find(c => c.id === id);
    if (cat) {
      Object.assign(cat, properties);
      saveConfig();
      loadConfig();
      broadcastConfigReload();
      return res.json({ success: true });
    }
  }

  if (type === 'shortcut') {
    const link = config.quick_links?.[index];
    if (link) {
      Object.assign(link, properties);
      saveConfig();
      loadConfig();
      broadcastConfigReload();
      return res.json({ success: true });
    }
  }

  if (type === 'bookmark') {
    const bm = config.bookmarks?.[index];
    if (bm) {
      Object.assign(bm, properties);
      saveConfig();
      loadConfig();
      broadcastConfigReload();
      return res.json({ success: true });
    }
  }

  if (type === 'project') {
    const proj = projectsList.find(p => p.id === id);
    if (proj) {
      Object.assign(proj, properties);
      saveProjects();
      loadConfig();
      broadcastConfigReload();
      return res.json({ success: true });
    }
  }

  if (type === 'docker') {
    const doc = dockerList.find(d => d.id === id);
    if (doc) {
      Object.assign(doc, properties);
      saveDocker();
      loadConfig();
      broadcastConfigReload();
      return res.json({ success: true });
    }
  }

  return res.status(404).json({ error: 'Item not found or invalid type' });
});

// Hide project permanently
app.post('/api/project/hide', (req, res) => {
  const { projectId, isDocker } = req.body;
  if (!projectId) return res.status(400).json({ error: 'Missing projectId' });
  
  if (isDocker) {
    const idx = dockerList.findIndex(p => p.id === projectId);
    if (idx !== -1) {
      dockerList[idx].hidden = true;
      saveDocker();
      console.log(`[Server] Hiding docker container project: ${projectId}`);
      loadConfig();
      broadcastConfigReload();
      return res.json({ success: true });
    }
  } else {
    const idx = projectsList.findIndex(p => p.id === projectId);
    if (idx !== -1) {
      projectsList[idx].hidden = true;
      saveProjects();
      console.log(`[Server] Hiding project: ${projectId}`);
      loadConfig();
      broadcastConfigReload();
      return res.json({ success: true });
    }
  }
  
  res.status(404).json({ error: 'Project not found' });
});

// Reorder layout elements
app.post('/api/layout/reorder', (req, res) => {
  const { type, items } = req.body;
  if (!type || !items) return res.status(400).json({ error: 'Missing type or items' });
  
  if (type === 'projects') {
    const newProjects = [];
    items.forEach(id => {
      const proj = projectsList.find(p => p.id === id);
      if (proj) newProjects.push(proj);
    });
    projectsList.forEach(proj => {
      if (!newProjects.some(p => p.id === proj.id)) {
        newProjects.push(proj);
      }
    });
    projectsList = newProjects;
    saveProjects();
    loadConfig();
    broadcastConfigReload();
    return res.json({ success: true });
  } else if (type === 'docker') {
    const newDocker = [];
    items.forEach(id => {
      const proj = dockerList.find(p => p.id === id);
      if (proj) newDocker.push(proj);
    });
    dockerList.forEach(proj => {
      if (!newDocker.some(p => p.id === proj.id)) {
        newDocker.push(proj);
      }
    });
    dockerList = newDocker;
    saveDocker();
    loadConfig();
    broadcastConfigReload();
    return res.json({ success: true });
  } else if (type === 'quick_links') {
    const newQuickLinks = [];
    items.forEach(name => {
      const link = config.quick_links.find(l => l.name === name);
      if (link) newQuickLinks.push(link);
    });
    config.quick_links.forEach(link => {
      if (!newQuickLinks.some(l => l.name === link.name)) {
        newQuickLinks.push(link);
      }
    });
    config.quick_links = newQuickLinks;
    saveConfig();
    loadConfig();
    broadcastConfigReload();
    return res.json({ success: true });
  } else if (type === 'bookmarks') {
    const newBookmarks = [];
    items.forEach(name => {
      const bm = config.bookmarks.find(b => b.name === name);
      if (bm) newBookmarks.push(bm);
    });
    config.bookmarks.forEach(bm => {
      if (!newBookmarks.some(b => b.name === bm.name)) {
        newBookmarks.push(bm);
      }
    });
    config.bookmarks = newBookmarks;
    saveConfig();
    loadConfig();
    broadcastConfigReload();
    return res.json({ success: true });
  } else if (type === 'categories') {
    const newCategories = [];
    items.forEach(id => {
      const cat = config.categories.find(c => c.id === id);
      if (cat) newCategories.push(cat);
    });
    config.categories.forEach(cat => {
      if (!newCategories.some(c => c.id === cat.id)) {
        newCategories.push(cat);
      }
    });
    config.categories = newCategories;
    saveConfig();
    loadConfig();
    broadcastConfigReload();
    return res.json({ success: true });
  } else if (type === 'tab_order') {
    if (!config.ui) config.ui = {};
    config.ui.tab_order = items;
    saveConfig();
    loadConfig();
    broadcastConfigReload();
    return res.json({ success: true });
  } else if (type === 'sidebar_widgets') {
    if (!config.ui) config.ui = {};
    config.ui.sidebar_widgets_order = items;
    saveConfig();
    loadConfig();
    broadcastConfigReload();
    return res.json({ success: true });
  }
  
  res.status(400).json({ error: 'Invalid reorder type' });
});

// Docker Container Management API
app.post('/api/docker/start', (req, res) => {
  const { container } = req.body;
  if (!container) return res.status(400).json({ error: 'Missing container name' });
  exec(`docker start "${container}"`, (error, stdout, stderr) => {
    if (error) return res.json({ success: false, error: stderr || error.message });
    res.json({ success: true });
  });
});

app.post('/api/docker/stop', (req, res) => {
  const { container } = req.body;
  if (!container) return res.status(400).json({ error: 'Missing container name' });
  exec(`docker stop "${container}"`, (error, stdout, stderr) => {
    if (error) return res.json({ success: false, error: stderr || error.message });
    res.json({ success: true });
  });
});

app.get('/api/docker/logs/:container', (req, res) => {
  const container = req.params.container;
  exec(`docker logs --tail 300 "${container}"`, { maxBuffer: 1024 * 1024 * 5 }, (error, stdout, stderr) => {
    // Merging stdout and stderr because Docker streams container log data to both
    const logs = (stdout || '') + (stderr || '');
    res.json({ success: true, logs });
  });
});

// System Monitor Info
app.get('/api/system/stats', async (req, res) => {
  try {
    const cpuLoad = await si.currentLoad();
    const memory = await si.mem();
    const disk = await si.fsSize();
    const osInfo = await si.osInfo();
    
    res.json({
      cpu: {
        load: cpuLoad.currentLoad,
        cores: cpuLoad.cpus.map(c => c.load)
      },
      memory: {
        total: memory.total,
        active: memory.active,
        usedPercent: (memory.active / memory.total) * 100
      },
      disk: disk.map(d => ({
        fs: d.fs,
        size: d.size,
        use: d.use,
        mount: d.mount
      })),
      os: {
        platform: osInfo.platform,
        distro: osInfo.distro,
        release: osInfo.release,
        hostname: osInfo.hostname,
        uptime: si.time().uptime
      }
    });
  } catch (err) {
    console.error('System Info fetch failed:', err);
    res.status(500).json({ error: 'Failed to fetch system information' });
  }
});

// Randomize background from rclone
async function randomizeBackground() {
  return new Promise((resolve, reject) => {
    console.log('[Server] Querying rclone backgrounds list...');
    exec('rclone lsf Pekempy:"Media/Photography/Collections/Backgrounds/Triple Wallpapers"', (err, stdout, stderr) => {
      if (err) {
        console.error('[Server] Failed to list rclone wallpapers:', err);
        return reject(err);
      }
      
      const files = stdout.split('\n')
        .map(f => f.trim())
        .filter(f => {
          if (!f) return false;
          const ext = path.extname(f).toLowerCase();
          return ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext);
        });
        
      if (files.length === 0) {
        console.error('[Server] No matching image files found in rclone directory.');
        return reject(new Error('No images found'));
      }
      
      const randomFile = files[Math.floor(Math.random() * files.length)];
      console.log(`[Server] Selected random background: ${randomFile}`);
      
      const destPath = path.join(__dirname, 'public', 'background.jpg');
      
      exec(`rclone copyto "Pekempy:Media/Photography/Collections/Backgrounds/Triple Wallpapers/${randomFile}" "${destPath}"`, (copyErr) => {
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

// Randomize background endpoint
app.post('/api/background/randomize', async (req, res) => {
  try {
    const filename = await randomizeBackground();
    res.json({ success: true, filename });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Server-Sent Events (SSE) route for real-time status and logs streaming
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  
  // Send immediate connected message
  res.write(`data: ${JSON.stringify({ type: 'connected', time: new Date() })}\n\n`);
  
  sseClients.add(res);
  console.log(`[SSE] Client connected. Total clients: ${sseClients.size}`);
  
  req.on('close', () => {
    sseClients.delete(res);
    console.log(`[SSE] Client disconnected. Total clients: ${sseClients.size}`);
  });
});

const DOCKER_PRESETS = {
  'nzbget': { icon: '📥', desc: 'Usenet downloader written in C++.' },
  'filebrowser': { icon: '📂', desc: 'Web-based file manager interface.' },
  'homeassistant': { icon: '🏠', desc: 'Open source home automation hub.' },
  'tautulli': { icon: '📊', desc: 'Plex monitoring and analytics tool.' },
  'speedtest-tracker': { icon: '⚡', desc: 'Self-hosted speedtest runner and logger.' },
  'speedtest': { icon: '⚡', desc: 'Self-hosted speedtest runner.' },
  'dawarich': { icon: '🗺️', desc: 'Self-hosted location history tracker.' },
  'paperless': { icon: '📄', desc: 'Document management system with OCR.' },
  'n8n': { icon: '🔗', desc: 'Workflow automation tool.' },
  'prowlarr': { icon: '🔍', desc: 'Indexer manager for Usenet and BitTorrent.' },
  'jellyfin': { icon: '🍿', desc: 'Free software media system for streaming.' },
  'bazarr': { icon: '✍️', desc: 'Subtitle manager companion to Sonarr and Radarr.' },
  'radarr': { icon: '🎬', desc: 'Movie manager and downloader coordinator.' },
  'sonarr': { icon: '📺', desc: 'TV series manager and downloader coordinator.' },
  'audiobookshelf': { icon: '🎙️', desc: 'Self-hosted audiobooks and podcasts server.' },
  'seerr': { icon: '🎫', desc: 'Request management and media discovery tool.' },
  'overseerr': { icon: '🎫', desc: 'Request management and media discovery tool.' },
  'authentik': { icon: '🛡️', desc: 'Identity provider and single sign-on hub.' },
  'vaultwarden': { icon: '🔑', desc: 'Lightweight Bitwarden-compatible password manager.' },
  'caddy': { icon: '🌐', desc: 'Fast web server with automatic HTTPS.' },
  'romm': { icon: '🎮', desc: 'Rom manager and emulator frontend.' },
  'storyteller': { icon: '📖', desc: 'Ebook and audiobook syncing platform.' },
  'wizarr': { icon: '🪄', desc: 'Invitation and user management system.' },
  'mealie': { icon: '🍳', desc: 'Recipe manager and meal planner.' },
  'it-tools': { icon: '🧰', desc: 'Handy developer utilities toolset.' },
  'wallos': { icon: '💰', desc: 'Subscription and finance tracker.' },
  'karakeep': { icon: '🎤', desc: 'Karaoke catalog and queuing manager.' },
  'reconmirror': { icon: '🪞', desc: 'Database replication and backup tool.' },
  'socket-proxy': { icon: '🔌', desc: 'Secure proxy for Docker socket access.' },
  'plex': { icon: '🎬', desc: 'Plex Media Server container.' },
  'redis': { icon: '🗄️', desc: 'In-memory database and caching store.' },
  'postgres': { icon: '🐘', desc: 'PostgreSQL relational database.' },
  'db': { icon: '🗄️', desc: 'Database server container.' },
  'mariadb': { icon: '🦭', desc: 'MariaDB relational database.' },
  'mysql': { icon: '🐬', desc: 'MySQL relational database.' },
  'mongo': { icon: '🍃', desc: 'MongoDB NoSQL database.' },
  'broker': { icon: '🔌', desc: 'Message broker/queue service.' },
  'rabbitmq': { icon: '🐇', desc: 'RabbitMQ message broker.' },
  'mqtt': { icon: '🔌', desc: 'MQTT message broker.' },
  'sidekiq': { icon: '⏱️', desc: 'Background job processing worker.' },
  'tika': { icon: '⚙️', desc: 'Apache Tika document analysis engine.' },
  'gotenberg': { icon: '⚙️', desc: 'Gotenberg PDF conversion API.' },
  'chrome': { icon: '🌐', desc: 'Headless Chrome browser instance.' },
  'machine-learning': { icon: '🧠', desc: 'Machine learning/AI helper service.' },
  'ml': { icon: '🧠', desc: 'Machine learning service.' },
  'proxy': { icon: '🛡️', desc: 'Reverse proxy / routing agent.' },
  'nextcloud': { icon: '☁️', desc: 'Nextcloud self-hosted cloud platform.' },
  'portainer': { icon: '🐳', desc: 'Docker container management web interface.' },
  'linkburner': { icon: '🔥', desc: 'Link Burner sharing link generator.' },
  'qui': { icon: '🤖', desc: 'Autobrr web user interface.' },
  'canvascrafter': { icon: '🎨', desc: 'Canvas Crafter project.' },
  'pogo-vault': { icon: '🎮', desc: 'Pogo Vault Pokémon tracker.' },
  'hawk-chat': { icon: '💬', desc: 'Hawk Chat AI helper.' },
  'meilisearch': { icon: '🔍', desc: 'Meilisearch search engine container.' },
  'linkdatabase': { icon: '🔗', desc: 'Link Database manager.' },
  'homepage': { icon: '🏠', desc: 'Homepage dashboard developer portal.' },
  'monitoring': { icon: '📊', desc: 'Glances system monitoring container.' },
  'libraryviewer': { icon: '📚', desc: 'Library Viewer catalog interface.' },
  'encoraplexprovider': { icon: '🎬', desc: 'Encora Plex metadata provider.' },
  'rustdesk': { icon: '🖥️', desc: 'RustDesk remote desktop server container.' }
};

function getDockerPreset(containerName) {
  const norm = containerName.toLowerCase().replace(/[-_]/g, '');
  
  // First, check exact keys
  for (const [key, preset] of Object.entries(DOCKER_PRESETS)) {
    const normKey = key.replace(/[-_]/g, '');
    if (norm === normKey) {
      return preset;
    }
  }
  
  // Then check substring keys
  for (const [key, preset] of Object.entries(DOCKER_PRESETS)) {
    const normKey = key.replace(/[-_]/g, '');
    if (norm.includes(normKey) || normKey.includes(norm)) {
      return preset;
    }
  }
  
  return null;
}

// Auto populate Docker list from system docker ps -a
function autoPopulateDocker() {
  exec('docker ps -a --format "{{.Names}}\t{{.Ports}}\t{{.Image}}"', (error, stdout, stderr) => {
    if (error) {
      return;
    }
    const lines = stdout.trim().split('\n').filter(Boolean);
    let changed = false;
    
    lines.forEach(line => {
      const parts = line.split('\t');
      const name = parts[0]?.trim();
      const portsStr = parts[1]?.trim() || '';
      const imageStr = parts[2]?.trim() || '';
      
      if (!name) return;
      
      // Parse mapped port
      let portVal = null;
      if (portsStr) {
        const match = portsStr.match(/:(\d+)->/);
        if (match) {
          portVal = parseInt(match[1]);
        }
      }
      
      const exists = dockerList.find(p => p.status && p.status.docker === name);
      const preset = getDockerPreset(name);
      
      const cleanImage = imageStr ? imageStr.split(':')[0].split('/').pop() : '';
      const dynamicDesc = preset ? preset.desc : (cleanImage ? `Auto-discovered container running ${cleanImage}.` : 'Auto-discovered Docker container.');
      
      if (!exists) {
        const id = name.toLowerCase().replace(/[^a-z0-9]/g, '');
        let finalId = id;
        let counter = 1;
        while (dockerList.some(p => p.id === finalId)) {
          finalId = `${id}${counter}`;
          counter++;
        }
        
        const displayName = name
          .split(/[-_]/)
          .map(word => word.charAt(0).toUpperCase() + word.slice(1))
          .join(' ');
        
        const newContainer = {
          id: finalId,
          name: displayName,
          path: '',
          category: 'web',
          description: dynamicDesc,
          icon: preset ? preset.icon : '🐳',
          actions: [],
          status: {
            git: false,
            docker: name
          },
          hidden: false
        };
        
        if (portVal) {
          newContainer.status.port = portVal;
        }
        
        dockerList.push(newContainer);
        changed = true;
      } else {
        // Update existing if defaults are present or port changed
        let updated = false;
        
        if (exists.icon === '🐳' && preset && preset.icon !== '🐳') {
          exists.icon = preset.icon;
          updated = true;
        }
        
        if ((exists.description === 'Auto-discovered Docker container.' || !exists.description) && dynamicDesc !== exists.description) {
          exists.description = dynamicDesc;
          updated = true;
        }
        
        if (portVal && exists.status.port !== portVal) {
          exists.status.port = portVal;
          updated = true;
        }
        if (updated) {
          changed = true;
        }
      }
    });
    
    if (changed) {
      console.log('[Docker Discover] Discovered/Updated docker containers. Saving docker.yaml...');
      saveDocker();
      broadcastConfigReload();
    }
  });
}

// Start auto discovery every 30 seconds
autoPopulateDocker();
setInterval(autoPopulateDocker, 30000);

// Start Server
const PORT = config.server.port || 4848;
const HOST = config.server.host || 'localhost';

app.listen(PORT, HOST, () => {
  console.log(`[Server] Dashboard listening on http://${HOST}:${PORT}`);
  // Initial background load
  randomizeBackground().catch(err => console.error('[Server] Initial background fetch failed:', err.message));
});
