const fs = require('fs');
const path = require('path');
const crashLogPath = path.join(__dirname, 'crash.log');

process.on('uncaughtException', err => {
  const msg = `[${new Date().toISOString()}] UncaughtException: ${err.stack || err}\n`;
  console.error(msg);
  try { fs.appendFileSync(crashLogPath, msg); } catch {}
});
process.on('unhandledRejection', reason => {
  const msg = `[${new Date().toISOString()}] UnhandledRejection: ${reason.stack || reason}\n`;
  console.error(msg);
  try { fs.appendFileSync(crashLogPath, msg); } catch {}
});
process.on('exit', code => {
  const msg = `[${new Date().toISOString()}] Process exit with code: ${code}\n`;
  console.log(msg);
  try { fs.appendFileSync(crashLogPath, msg); } catch {}
});
process.on('SIGTERM', () => {
  const msg = `[${new Date().toISOString()}] Process received SIGTERM\n`;
  console.log(msg);
  try { fs.appendFileSync(crashLogPath, msg); } catch {}
});
process.on('SIGINT', () => {
  const msg = `[${new Date().toISOString()}] Process received SIGINT\n`;
  console.log(msg);
  try { fs.appendFileSync(crashLogPath, msg); } catch {}
});

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const os = require('os');
const { execFile, exec } = require('child_process');
const { PNG } = require('pngjs');
const { setDiscordWebhook, sendDiscordNotification, getDiscordConfig } = require('./discord-bridge');
const routing = require('./routing');
const { initDiscordBot, broadcastToDiscord, sendDiscordPermissionPrompt, sendFinalAgentResponse, updateDiscordUsageMonitor, sendDiscordAnnouncement } = require('./discord-bot');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

const PORT = 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const BRAIN_DIR = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
const LOCAL_ASSETS_DIR = path.join(__dirname, 'assets');
const LAYOUT_PATH = path.join(LOCAL_ASSETS_DIR, 'layout.json');
const WORKSPACE_DIR = path.resolve(__dirname);
const QUEUE_FILE = path.join(WORKSPACE_DIR, 'tasks_queue.json');

// Gestione atomica della coda dei task (Prescrizioni Carlo QA)
function loadTaskQueue() {
  try {
    if (fs.existsSync(QUEUE_FILE)) {
      return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
    }
  } catch {}
  return [];
}

function saveTaskQueue(tasks) {
  try {
    const trimmed = Array.isArray(tasks) ? tasks.slice(-50) : [];
    const tmp = QUEUE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(trimmed, null, 2), 'utf8');
    fs.renameSync(tmp, QUEUE_FILE);
    try {
      broadcast({ type: 'tasksQueueUpdated', queue: trimmed, mode: routing.getMode() });
    } catch {}
  } catch (err) {
    console.error('[Queue] Errore salvataggio coda atomica:', err.message);
  }
}

// Whitelist comandi consentiti (Tier 1 Sandbox)
const WHITELISTED_COMMANDS = {
  'status': { file: 'git', args: ['status', '--short'], label: 'Git Status (Short)' },
  'git status': { file: 'git', args: ['status'], label: 'Git Status Completo' },
  'git status --short': { file: 'git', args: ['status', '--short'], label: 'Git Status' },
  'git diff': { file: 'git', args: ['diff', '--stat'], label: 'Git Diff Riepilogo' },
  'git log': { file: 'git', args: ['log', '-n', '5', '--oneline'], label: 'Git Log Recenti' },
  'node -v': { file: 'node', args: ['--version'], label: 'Node Version' },
  'node --version': { file: 'node', args: ['--version'], label: 'Node Version' },
  'git -v': { file: 'git', args: ['--version'], label: 'Git Version' },
  'git --version': { file: 'git', args: ['--version'], label: 'Git Version' },
  'audit': { file: 'git', args: ['status', '--porcelain'], label: 'Audit Integrità Repository' }
};

// Command Bridge Reale: esecuzione effettiva e dispatching
function dispatchRealTask(agent, rawInput) {
  const text = (rawInput || '').trim().slice(0, 500);
  if (!text) return;

  const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const toolId = `tool_${Date.now()}`;
  const now = new Date();

  let targetCmd = null;
  let isSystemCommand = false;

  const lower = text.toLowerCase();
  if (lower.includes('check di integrità') || lower.includes('check stato')) {
    targetCmd = WHITELISTED_COMMANDS['git status --short'];
    isSystemCommand = true;
  } else if (lower === 'git status' || lower.includes('verifica modifiche')) {
    targetCmd = WHITELISTED_COMMANDS['git status'];
    isSystemCommand = true;
  } else if (lower.includes('audit sicurezza') || lower.includes('qa')) {
    targetCmd = WHITELISTED_COMMANDS['audit'];
    isSystemCommand = true;
  } else if (lower.includes('documentazione') || lower.includes('storico')) {
    targetCmd = WHITELISTED_COMMANDS['git log'];
    isSystemCommand = true;
  } else if (WHITELISTED_COMMANDS[lower]) {
    targetCmd = WHITELISTED_COMMANDS[lower];
    isSystemCommand = true;
  }

  const tasks = loadTaskQueue();
  const taskEntry = {
    id: taskId,
    timestamp: now.toISOString(),
    agentId: agent.id,
    agentName: agent.name,
    category: isSystemCommand ? 'command' : 'prompt',
    command: isSystemCommand ? targetCmd.label : text,
    prompt: text,
    status: 'running',
    exitCode: null,
    output: null
  };
  tasks.push(taskEntry);
  saveTaskQueue(tasks);

  const logStart = `[${now.toLocaleTimeString()}] ⚡ Avvio esecuzione reale: "${taskEntry.command}"`;
  agent.logs.push(logStart);

  // Attiva lo stato lavorativo e animazione typing al PC nel canvas
  broadcast({
    type: 'agentToolStart',
    id: agent.id,
    agentId: agent.id,
    toolId: toolId,
    status: `Eseguo: ${taskEntry.command}`,
    toolName: 'Terminal'
  });

  broadcast({
    type: 'agentActivity',
    id: agent.id,
    agentId: agent.id,
    tool: 'Terminal',
    status: `Eseguo: ${taskEntry.command}`,
    log: logStart
  });

  if (isSystemCommand && targetCmd) {
    const options = {
      cwd: routing.getTargetProject() || WORKSPACE_DIR,
      timeout: 15000,
      maxBuffer: 512 * 1024,
      windowsHide: true
    };

    const bin = process.platform === 'win32' && targetCmd.file === 'git' ? 'git.exe' : targetCmd.file;

    execFile(bin, targetCmd.args, options, (err, stdout, stderr) => {
      const finishTime = new Date();
      const exitCode = err ? (err.code || 1) : 0;
      let rawOut = (stdout || stderr || (err ? err.message : '')).trim();
      if (!rawOut && exitCode === 0) {
        rawOut = 'Working tree pulito, nessuna modifica pendente.';
      }

      taskEntry.status = exitCode === 0 ? 'completed' : 'failed';
      taskEntry.exitCode = exitCode;
      taskEntry.output = rawOut;
      saveTaskQueue(tasks);

      const logEnd = `[${finishTime.toLocaleTimeString()}] ${exitCode === 0 ? '✔' : '✖'} Comando "${targetCmd.label}" completato (codice ${exitCode})`;
      agent.logs.push(logEnd);

      // Invia il risultato reale della console al terminale web
      broadcast({
        type: 'commandResult',
        id: agent.id,
        agentId: agent.id,
        taskId: taskId,
        command: targetCmd.label,
        output: rawOut,
        exitCode: exitCode,
        time: finishTime.toLocaleTimeString()
      });

      broadcast({
        type: 'agentActivity',
        id: agent.id,
        agentId: agent.id,
        tool: 'Terminal',
        status: exitCode === 0 ? 'Completato con successo' : 'Terminato con errore',
        log: logEnd
      });

      // Disattiva l'animazione al PC e riporta l'agente a riposo/attesa
      setTimeout(() => {
        broadcast({
          type: 'agentToolDone',
          id: agent.id,
          agentId: agent.id,
          toolId: toolId
        });
        broadcast({
          type: 'agentToolsClear',
          id: agent.id,
          agentId: agent.id
        });
        broadcast({
          type: 'agentStatus',
          id: agent.id,
          agentId: agent.id,
          status: 'waiting'
        });
      }, 700);
    });
  } else if (routing.isResting()) {
    // Tutti a riposo: mette il task in coda per eseguirlo automaticamente al risveglio
    const qPos = routing.enqueueRestTask({ agentId: agent.id, text, source: 'Web Dashboard' });
    const restMsg = `${routing.restMessage()}\n📥 Il tuo task ("${text.slice(0, 60)}") è stato salvato in coda (#${qPos}) e partirà in automatico al risveglio!`;
    taskEntry.status = 'queued_rest';
    taskEntry.exitCode = 0;
    taskEntry.output = restMsg;
    saveTaskQueue(tasks);
    agent.logs.push(`[${now.toLocaleTimeString()}] 📥 In coda per risveglio (#${qPos}): "${text}"`);
    broadcast({
      type: 'commandResult',
      id: agent.id,
      agentId: agent.id,
      taskId: taskId,
      command: text,
      output: restMsg,
      exitCode: 0,
      time: now.toLocaleTimeString()
    });
  } else {
    // Tier 2: Task reale verso il subagent di Antigravity (risolto dinamicamente da agents.config.json via routing.js)
    const targetSubagentId = routing.resolveSubagent(agent.id);
    const logForward = `[${now.toLocaleTimeString()}] 📨 Inoltro messaggio reale a subagent Antigravity (${targetSubagentId.slice(0, 8)}...)`;
    agent.logs.push(logForward);

    // Se il comando viene assegnato a un membro del team diverso da Alberto (o se il prompt per Alberto nomina un collega), mostra Alberto che cammina a consegnargli il compito!
    if (agent.id !== 10) {
      broadcast({
        type: 'agentDelegation',
        fromAgentId: 10,
        toAgentId: agent.id,
        fromName: 'Alberto (CEO)',
        toName: agent.name,
        message: text
      });
    } else {
      const lower = text.toLowerCase();
      const mentioned = lower.includes('luigi') ? 6 : (lower.includes('gabri') ? 7 : (lower.includes('carlo') ? 8 : null));
      if (mentioned) {
        const destAgent = TEAM.find(a => a.id === mentioned);
        broadcast({
          type: 'agentDelegation',
          fromAgentId: 10,
          toAgentId: mentioned,
          fromName: 'Alberto (CEO)',
          toName: destAgent ? destAgent.name : `Agente ${mentioned}`,
          message: text
        });
      }
    }

    // Invia direttamente tramite l'eseguibile nativo language_server.exe agentapi send-message
    const serverExe = path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'antigravity', 'resources', 'bin', 'language_server.exe');
    const activeProj = routing.getTargetProject();
    const msgContent = `[Progetto Target Attivo: ${activeProj}] Messaggio operativo dalla Dashboard Web AziendaAI: ${text}`;

    execFile(serverExe, ['agentapi', 'send-message', targetSubagentId, msgContent], { timeout: 15000, windowsHide: true }, (apiErr, apiStdout, apiStderr) => {
      const finishTime = new Date();
      const exitCode = apiErr ? 1 : 0;
      const apiOut = (apiStdout || apiStderr || '').trim();
      const success = exitCode === 0;

      taskEntry.status = success ? 'dispatched' : 'failed';
      taskEntry.exitCode = exitCode;
      taskEntry.output = success 
        ? `Task recapitato al subagent (${agent.name}). Elaborazione in corso su Antigravity...`
        : `Errore inoltro: ${apiErr ? apiErr.message : 'timeout'}`;
      saveTaskQueue(tasks);

      const logEnd = `[${finishTime.toLocaleTimeString()}] ${success ? '✔' : '✖'} ${taskEntry.output}`;
      agent.logs.push(logEnd);

      // Replicazione automatica su Discord se attivo
      sendDiscordNotification(agent.name, `**Nuovo Task Inoltrato:**\n${text}\n\n*${taskEntry.output}*`, success ? 0x2ea043 : 0xda3633);

      broadcast({
        type: 'commandResult',
        id: agent.id,
        agentId: agent.id,
        taskId: taskId,
        command: text,
        output: taskEntry.output,
        exitCode: exitCode,
        time: finishTime.toLocaleTimeString()
      });

      broadcast({
        type: 'agentActivity',
        id: agent.id,
        agentId: agent.id,
        tool: 'Antigravity Chat',
        status: success ? 'In elaborazione su Antigravity' : 'Errore recapito',
        log: logEnd
      });

      // Mantiene l'animazione di lavoro finché il monitor live transcript non intercetta la risposta
      setTimeout(() => {
        broadcast({
          type: 'agentToolDone',
          id: agent.id,
          agentId: agent.id,
          toolId: toolId
        });
      }, 1000);
    });
  }
}

app.use(express.json());
app.use(express.static(PUBLIC_DIR));

// Helper: Converte RGBA a stringa hex (#RRGGBB o #RRGGBBAA)
function colorToHex(r, g, b, a) {
  if (a < 2) return '';
  const hex = '#' + r.toString(16).padStart(2, '0') + g.toString(16).padStart(2, '0') + b.toString(16).padStart(2, '0');
  return (a >= 255 ? hex : hex + a.toString(16).padStart(2, '0')).toUpperCase();
}

// Caricatore pixel grid da Buffer PNG
function parsePngGrid(buf, width, height) {
  const png = PNG.sync.read(buf);
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = [];
    for (let x = 0; x < width; x++) {
      const idx = (y * png.width + x) * 4;
      row.push(colorToHex(png.data[idx], png.data[idx + 1], png.data[idx + 2], png.data[idx + 3]));
    }
    rows.push(row);
  }
  return rows;
}

// 1. Carica floor tiles
function loadFloorTiles() {
  const floorDir = path.join(LOCAL_ASSETS_DIR, 'floors');
  if (!fs.existsSync(floorDir)) return [];
  const files = fs.readdirSync(floorDir)
    .filter(f => /^floor_\d+\.png$/i.test(f))
    .sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10));
  
  return files.map(file => {
    const buf = fs.readFileSync(path.join(floorDir, file));
    return parsePngGrid(buf, 16, 16);
  });
}

// 2. Carica wall tiles (16 varianti 16x32 per set)
function loadWallTiles() {
  const wallDir = path.join(LOCAL_ASSETS_DIR, 'walls');
  if (!fs.existsSync(wallDir)) return [];
  const files = fs.readdirSync(wallDir)
    .filter(f => /^wall_\d+\.png$/i.test(f))
    .sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10));

  return files.map(file => {
    const buf = fs.readFileSync(path.join(wallDir, file));
    const png = PNG.sync.read(buf);
    const variants = [];
    for (let r = 0; r < 16; r++) {
      const offsetX = (r % 4) * 16;
      const offsetY = Math.floor(r / 4) * 32;
      const grid = [];
      for (let y = 0; y < 32; y++) {
        const row = [];
        for (let x = 0; x < 16; x++) {
          const idx = ((offsetY + y) * png.width + (offsetX + x)) * 4;
          row.push(colorToHex(png.data[idx], png.data[idx + 1], png.data[idx + 2], png.data[idx + 3]));
        }
        grid.push(row);
      }
      variants.push(grid);
    }
    return variants;
  });
}

// 3. Carica carpet tiles (16 varianti 16x16 per set)
function loadCarpetTiles() {
  const carpetDir = path.join(LOCAL_ASSETS_DIR, 'carpets');
  if (!fs.existsSync(carpetDir)) return [];
  const files = fs.readdirSync(carpetDir)
    .filter(f => /^carpet_\d+\.png$/i.test(f))
    .sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10));

  return files.map(file => {
    const buf = fs.readFileSync(path.join(carpetDir, file));
    const png = PNG.sync.read(buf);
    const variants = [];
    for (let r = 0; r < 16; r++) {
      const offsetX = (r % 4) * 16;
      const offsetY = Math.floor(r / 4) * 16;
      const grid = [];
      for (let y = 0; y < 16; y++) {
        const row = [];
        for (let x = 0; x < 16; x++) {
          const idx = ((offsetY + y) * png.width + (offsetX + x)) * 4;
          row.push(colorToHex(png.data[idx], png.data[idx + 1], png.data[idx + 2], png.data[idx + 3]));
        }
        grid.push(row);
      }
      variants.push(grid);
    }
    return variants;
  });
}

// 4. Carica character sprites (down, up, right; 7 frame 16x32 ciascuno)
function loadCharacterSprites() {
  const charDir = path.join(LOCAL_ASSETS_DIR, 'characters');
  const characters = [];
  const directions = ['down', 'up', 'right'];

  for (let i = 0; i < 6; i++) {
    const charFile = path.join(charDir, `char_${i}.png`);
    if (!fs.existsSync(charFile)) continue;
    const buf = fs.readFileSync(charFile);
    const png = PNG.sync.read(buf);
    const charData = { down: [], up: [], right: [] };

    for (let d = 0; d < directions.length; d++) {
      const dir = directions[d];
      const rowOffset = d * 32;
      const frames = [];
      for (let f = 0; f < 7; f++) {
        const colOffset = f * 16;
        const frame = [];
        for (let y = 0; y < 32; y++) {
          const row = [];
          for (let x = 0; x < 16; x++) {
            const idx = ((rowOffset + y) * png.width + (colOffset + x)) * 4;
            row.push(colorToHex(png.data[idx], png.data[idx + 1], png.data[idx + 2], png.data[idx + 3]));
          }
          frame.push(row);
        }
        frames.push(frame);
      }
      charData[dir] = frames;
    }
    characters.push(charData);
  }
  return characters;
}

// 5. Carica furniture catalog & sprites
function expandFurnitureManifest(item, base) {
  if (item.type === 'asset') {
    const o = item.orientation || base.orientation;
    const h = item.state || base.state;
    return [{
      id: item.id,
      name: base.name,
      label: base.name,
      category: base.category,
      file: item.file || (item.id + '.png'),
      width: item.width,
      height: item.height,
      footprintW: item.footprintW,
      footprintH: item.footprintH,
      isDesk: base.category === 'desks',
      canPlaceOnWalls: base.canPlaceOnWalls,
      canPlaceOnSurfaces: base.canPlaceOnSurfaces,
      backgroundTiles: base.backgroundTiles,
      groupId: base.groupId,
      ...(o ? { orientation: o } : {}),
      ...(h ? { state: h } : {}),
      ...(item.mirrorSide ? { mirrorSide: true } : {}),
      ...(base.rotationScheme ? { rotationScheme: base.rotationScheme } : {}),
      ...(base.animationGroup ? { animationGroup: base.animationGroup } : {}),
      ...(item.frame !== undefined ? { frame: item.frame } : {})
    }];
  }
  const res = [];
  for (const m of item.members) {
    const nextBase = Object.assign({}, base);
    if (item.groupType === 'rotation' && item.rotationScheme) nextBase.rotationScheme = item.rotationScheme;
    if (item.groupType === 'state') {
      if (item.orientation) nextBase.orientation = item.orientation;
      if (item.state) nextBase.state = item.state;
    }
    if (item.groupType === 'animation') {
      const ori = item.orientation || base.orientation || '';
      const st = item.state || base.state || '';
      nextBase.animationGroup = (base.groupId + '_' + ori + '_' + st).toUpperCase();
      if (item.state) nextBase.state = item.state;
    }
    if (item.orientation && !nextBase.orientation) nextBase.orientation = item.orientation;
    res.push(...expandFurnitureManifest(m, nextBase));
  }
  return res;
}

function loadFurnitureAssets() {
  const furnDir = path.join(LOCAL_ASSETS_DIR, 'furniture');
  if (!fs.existsSync(furnDir)) return { catalog: [], sprites: {} };
  const dirs = fs.readdirSync(furnDir, { withFileTypes: true }).filter(d => d.isDirectory());
  const catalog = [];
  const sprites = {};

  for (const d of dirs) {
    const n = path.join(furnDir, d.name);
    const mPath = path.join(n, 'manifest.json');
    if (!fs.existsSync(mPath)) continue;
    try {
      const manifest = JSON.parse(fs.readFileSync(mPath, 'utf8'));
      const base = {
        groupId: manifest.id,
        name: manifest.name,
        category: manifest.category,
        canPlaceOnWalls: manifest.canPlaceOnWalls,
        canPlaceOnSurfaces: manifest.canPlaceOnSurfaces,
        backgroundTiles: manifest.backgroundTiles
      };
      let items = [];
      if (manifest.type === 'asset') {
        items = [{
          id: manifest.id,
          name: manifest.name,
          label: manifest.name,
          category: manifest.category,
          file: manifest.file || (manifest.id + '.png'),
          width: manifest.width,
          height: manifest.height,
          footprintW: manifest.footprintW,
          footprintH: manifest.footprintH,
          isDesk: manifest.category === 'desks',
          canPlaceOnWalls: manifest.canPlaceOnWalls,
          canPlaceOnSurfaces: manifest.canPlaceOnSurfaces,
          backgroundTiles: manifest.backgroundTiles,
          groupId: manifest.id
        }];
      } else {
        if (manifest.rotationScheme) base.rotationScheme = manifest.rotationScheme;
        items = expandFurnitureManifest({
          type: 'group',
          groupType: manifest.groupType,
          rotationScheme: manifest.rotationScheme,
          members: manifest.members
        }, base);
      }
      for (const item of items) {
        const fPath = path.join(n, item.file);
        if (fs.existsSync(fPath)) {
          const buf = fs.readFileSync(fPath);
          sprites[item.id] = parsePngGrid(buf, item.width, item.height);
        }
      }
      catalog.push(...items);
    } catch (err) {
      console.warn(`[AssetLoader] Errore caricamento arredo ${d.name}:`, err.message);
    }
  }
  return { catalog, sprites };
}

// 6. Carica layout da assets/layout.json
function loadLayout() {
  try {
    if (fs.existsSync(LAYOUT_PATH)) {
      return JSON.parse(fs.readFileSync(LAYOUT_PATH, 'utf8'));
    }
  } catch (err) {
    console.error('[AziendaAI] Errore lettura layout.json:', err.message);
  }
  return null;
}

// Cache asset in memoria all'avvio
console.log('🔄 [AziendaAI] Caricamento e rasterizzazione asset nativi Pixel Agents...');
const ASSET_CACHE = {
  floors: loadFloorTiles(),
  walls: loadWallTiles(),
  carpets: loadCarpetTiles(),
  characters: loadCharacterSprites(),
  furniture: loadFurnitureAssets(),
  layout: loadLayout()
};
console.log(`✅ [AziendaAI] Asset pronti: ${ASSET_CACHE.characters.length} personaggi, ${ASSET_CACHE.floors.length} pavimenti, ${ASSET_CACHE.walls.length} muri, ${ASSET_CACHE.furniture.catalog.length} mobili.`);

// I membri permanenti del Team AziendaAI (personalizzabili da team.config.json)
const DEFAULT_TEAM = [
  {
    id: 10,
    sessionId: '11111111-1111-4111-a111-794016576579',
    name: 'Alberto (CEO)',
    agentName: 'Alberto (CEO)',
    role: 'CEO & Orchestrator',
    avatar: '👔',
    palette: 3,
    hueShift: 0,
    seatId: 'f-1773356768339-eo6u',
    isTeamLead: true,
    directoryName: 'AziendaAI',
    status: 'online',
    logs: [
      `[${new Date().toLocaleTimeString()}] Alberto (CEO) ha assunto il comando operativo.`,
      `[${new Date().toLocaleTimeString()}] Orchestrazione permanente del team attiva.`
    ]
  },
  {
    id: 6,
    sessionId: '22222222-2222-4222-a222-222222222222',
    name: 'Luigi (Backend)',
    agentName: 'Luigi (Backend)',
    role: 'Backend & Systems Engineer',
    avatar: '⚙️',
    palette: 0,
    hueShift: 0,
    seatId: 'f-1773354881902-9m50',
    isTeamLead: false,
    directoryName: 'AziendaAI',
    status: 'online',
    logs: [
      `[${new Date().toLocaleTimeString()}] Luigi ha sincronizzato il server HTTP/WebSocket.`,
      `[${new Date().toLocaleTimeString()}] Protocollo asset pixel e terminali operativi.`
    ]
  },
  {
    id: 7,
    sessionId: '33333333-3333-4333-a333-333333333333',
    name: 'Gabri (Frontend)',
    agentName: 'Gabri (Frontend)',
    role: 'Frontend Architect & UI Dev',
    avatar: '🎨',
    palette: 2,
    hueShift: 0,
    seatId: 'f-1773354879805-px9b',
    isTeamLead: false,
    directoryName: 'AziendaAI',
    status: 'online',
    logs: [
      `[${new Date().toLocaleTimeString()}] Gabri ha renderizzato la sala operativa pixel art.`,
      `[${new Date().toLocaleTimeString()}] Interfaccia webview reattiva pronta.`
    ]
  },
  {
    id: 8,
    sessionId: '44444444-4444-4444-a444-444444444444',
    name: 'Carlo (QA)',
    agentName: 'Carlo (QA)',
    role: 'Security Auditor & Code Revisor',
    avatar: '🛡️',
    palette: 5,
    hueShift: 0,
    seatId: 'f-1773354880309-yphd',
    isTeamLead: false,
    directoryName: 'AziendaAI',
    status: 'online',
    logs: [
      `[${new Date().toLocaleTimeString()}] Carlo operativo con verifica rigorosa canali RGBA.`,
      `[${new Date().toLocaleTimeString()}] Audit di sicurezza: integrità al 100%.`
    ]
  }
];

let TEAM = DEFAULT_TEAM;
try {
  const teamCfgPath = path.join(__dirname, 'team.config.json');
  if (fs.existsSync(teamCfgPath)) {
    const customTeam = JSON.parse(fs.readFileSync(teamCfgPath, 'utf8'));
    if (Array.isArray(customTeam) && customTeam.length > 0) {
      TEAM = customTeam.map((m, idx) => {
        const def = DEFAULT_TEAM.find(d => d.id === Number(m.id)) || DEFAULT_TEAM[idx % DEFAULT_TEAM.length];
        return {
          ...def,
          id: Number(m.id) || def.id,
          name: m.name || def.name,
          agentName: m.name || def.agentName,
          role: m.role || def.role,
          avatar: m.avatar || def.avatar || '🤖',
          palette: m.palette !== undefined ? Number(m.palette) : def.palette,
          hueShift: m.hueShift !== undefined ? Number(m.hueShift) : def.hueShift,
          seatId: m.seatId || def.seatId,
          isTeamLead: m.isTeamLead !== undefined ? Boolean(m.isTeamLead) : def.isTeamLead,
          directoryName: 'AziendaAI',
          status: 'online',
          logs: def.logs || [`[${new Date().toLocaleTimeString()}] ${m.name} operativo.`]
        };
      });
    }
  }
} catch (err) {
  console.warn('[AziendaAI] Errore lettura team.config.json, uso team default:', err.message);
}

// Broadcast WebSocket con gestione sicura degli errori
let isLoungeBreakActive = false;

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(msg, err => {
          if (err) console.warn('[WS Client Send Warn]:', err.message);
        });
      } catch (err) {
        console.warn('[WS Broadcast Catch]:', err.message);
      }
    }
  });
}

// Invia l'intero protocollo di inizializzazione alla Webview
function sendOfficeInitProtocol(ws) {
  // 1. Office Access & Impostazioni
  ws.send(JSON.stringify({ type: 'officeAccess', readOnly: false }));
  ws.send(JSON.stringify({
    type: 'settingsLoaded',
    soundEnabled: true,
    lastSeenVersion: '1.0',
    extensionVersion: '1.0',
    watchAllSessions: true,
    alwaysShowLabels: false,
    ghostHeadlessAgents: false,
    hooksEnabled: true,
    hooksInfoShown: true,
    showAreas: false,
    bypassPermissions: false,
    showHostDirectories: false
  }));
  ws.send(JSON.stringify({ type: 'terminalAvailability', available: false }));

  // 2. Asset Pixel Art
  if (ASSET_CACHE.characters && ASSET_CACHE.characters.length > 0) {
    ws.send(JSON.stringify({ type: 'characterSpritesLoaded', characters: ASSET_CACHE.characters }));
  }
  if (ASSET_CACHE.floors && ASSET_CACHE.floors.length > 0) {
    ws.send(JSON.stringify({ type: 'floorTilesLoaded', sprites: ASSET_CACHE.floors }));
  }
  if (ASSET_CACHE.walls && ASSET_CACHE.walls.length > 0) {
    ws.send(JSON.stringify({ type: 'wallTilesLoaded', sets: ASSET_CACHE.walls }));
  }
  if (ASSET_CACHE.carpets && ASSET_CACHE.carpets.length > 0) {
    ws.send(JSON.stringify({ type: 'carpetTilesLoaded', sets: ASSET_CACHE.carpets }));
  }
  if (ASSET_CACHE.furniture && ASSET_CACHE.furniture.catalog.length > 0) {
    ws.send(JSON.stringify({
      type: 'furnitureAssetsLoaded',
      catalog: ASSET_CACHE.furniture.catalog,
      sprites: ASSET_CACHE.furniture.sprites
    }));
  }

  // 3. Layout Stanza
  if (ASSET_CACHE.layout) {
    ws.send(JSON.stringify({ type: 'layoutLoaded', layout: ASSET_CACHE.layout }));
  }

  // 4. Agenti Permanenti
  const agentIds = TEAM.map(a => a.id);
  const agentMeta = {};
  const directoryNames = {};
  const externalAgents = {};

  TEAM.forEach(a => {
    agentMeta[a.id] = { palette: a.palette, hueShift: a.hueShift, seatId: a.seatId };
    directoryNames[a.id] = a.directoryName;
    externalAgents[a.id] = false;
  });

  ws.send(JSON.stringify({
    type: 'existingAgents',
    agents: agentIds,
    agentMeta: agentMeta,
    directoryNames: directoryNames,
    externalAgents: externalAgents
  }));

  // 5. Team Metadata e Sessioni Terminale
  TEAM.forEach(a => {
    ws.send(JSON.stringify({
      type: 'agentTeamInfo',
      id: a.id,
      teamName: 'AziendaAI',
      agentName: a.agentName,
      isTeamLead: a.isTeamLead
    }));
    ws.send(JSON.stringify({ type: 'terminalSessionOpened', agentId: a.id }));
  });

  // Invia anche lo stato team compatibile con dashboard custom
  ws.send(JSON.stringify({ type: 'init', team: TEAM }));
  ws.send(JSON.stringify({
    type: 'targetProjectChanged',
    projectPath: routing.getTargetProject(),
    projectName: path.basename(routing.getTargetProject())
  }));

  if (lastQuotaData) {
    ws.send(JSON.stringify({
      type: 'liveQuotaUpdate',
      quota: lastQuotaData
    }));
  }

  // Invia l'utilizzo token iniziale reale per tutti i membri
  for (const [sid, agentId] of Object.entries(SUBAGENT_MAP)) {
    const tok = getAgentActualTokens(sid);
    ws.send(JSON.stringify({
      type: 'agentContextUsage',
      id: agentId,
      agentId: agentId,
      contextTokens: tok.used,
      maxContextTokens: tok.max
    }));
  }

  // 6. Sincronizzazione stato Kanban & Lounge Break iniziale per il client
  // All'avvio e in sendOfficeInitProtocol, isLoungeBreakActive deve essere resettato a false
  // (salvo routing.isResting() === true), altrimenti la dashboard apre sempre con tutti sul divano.
  if (!routing.isResting()) {
    isLoungeBreakActive = false;
  }
  const loungeActive = routing.isResting() ? true : isLoungeBreakActive;

  ws.send(JSON.stringify({
    type: 'tasksQueueUpdated',
    queue: loadTaskQueue(),
    mode: routing.getMode()
  }));
  ws.send(JSON.stringify({
    type: 'loungeBreakState',
    active: loungeActive,
    reason: 'initial_sync'
  }));
}

// ==========================================
// TELEMETRIA QUOTE & MODELLI REALI ANTIGRAVITY (Connect-RPC)
// ==========================================
const DAEMON_DIR = path.join(os.homedir(), '.gemini', 'antigravity', 'daemon');
let cachedDaemonConfig = null;
let lastQuotaData = null;
let fallbackToClaude = false;

async function probeDaemonConfig(cfg) {
  return new Promise(resolve => {
    const body = JSON.stringify({});
    const req = http.request({
      hostname: '127.0.0.1',
      port: cfg.httpPort,
      path: '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary',
      method: 'POST',
      timeout: 1000,
      headers: {
        'Content-Type': 'application/json',
        'x-codeium-csrf-token': cfg.csrfToken,
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.write(body);
    req.end();
  });
}

async function getActiveDaemonConfig() {
  if (cachedDaemonConfig && await probeDaemonConfig(cachedDaemonConfig)) {
    return cachedDaemonConfig;
  }

  // Resetta cache se non valida per evitare tentativi ripetuti sulla porta morta
  cachedDaemonConfig = null;

  try {
    if (!fs.existsSync(DAEMON_DIR)) return null;
    const hubFiles = fs.readdirSync(DAEMON_DIR)
      .filter(f => f.startsWith('hub_') && f.endsWith('.json'))
      .map(f => {
        const full = path.join(DAEMON_DIR, f);
        return { file: f, mtime: fs.statSync(full).mtimeMs, path: full };
      })
      .sort((a, b) => b.mtime - a.mtime);

    for (const h of hubFiles) {
      try {
        const cfg = JSON.parse(fs.readFileSync(h.path, 'utf8'));
        if (cfg.httpPort && cfg.csrfToken) {
          if (await probeDaemonConfig(cfg)) {
            cachedDaemonConfig = cfg;
            return cfg;
          }
        }
      } catch {}
    }
  } catch {}
  return null;
}

async function fetchAntigravityRPC(method, payload = {}) {
  const cfg = await getActiveDaemonConfig();
  if (!cfg) throw new Error('Nessun daemon hub di Antigravity attivo trovato');

  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request({
      hostname: '127.0.0.1',
      port: cfg.httpPort,
      path: `/exa.language_server_pb.LanguageServerService/${method}`,
      method: 'POST',
      timeout: 3000,
      headers: {
        'Content-Type': 'application/json',
        'x-codeium-csrf-token': cfg.csrfToken,
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error('Risposta RPC non JSON: ' + e.message));
          }
        } else {
          reject(new Error(`RPC status ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('RPC timeout'));
    });
    req.write(body);
    req.end();
  });
}

async function getLiveQuotaAndModels() {
  try {
    const quotaRes = await fetchAntigravityRPC('RetrieveUserQuotaSummary', {});
    const groups = quotaRes?.response?.groups || [];

    const nm = g => (g.displayName || '').toLowerCase();
    let geminiGroup = groups.find(g => nm(g).includes('gemini') && !nm(g).includes('argon'));
    let claudeGroup = groups.find(g => nm(g).includes('claude'));
    const findB = (grp, re) => grp?.buckets?.find(b => re.test(String(b.window || '')));

    const g5h = findB(geminiGroup, /^5h$/) || findB(geminiGroup, /5h/);
    const gWeekly = findB(geminiGroup, /^weekly$/) || findB(geminiGroup, /weekly/);
    const c5h = findB(claudeGroup, /^3p-5h$/) || findB(claudeGroup, /5h/);
    const cWeekly = findB(claudeGroup, /^3p-weekly$/) || findB(claudeGroup, /weekly/);

    const g5hFrac = g5h ? (Number(g5h.remainingFraction) || 0) : 0;
    const gWeeklyFrac = gWeekly ? (Number(gWeekly.remainingFraction) || 0) : 0;
    const c5hFrac = c5h ? (Number(c5h.remainingFraction) || 0) : 1;
    const cWeeklyFrac = cWeekly ? (Number(cWeekly.remainingFraction) || 0) : 1;

    // Calcolo orari di reset (HH:MM) di Gemini e Claude e primo risveglio utile
    const fmtHM = v => { const d = new Date(v); return isNaN(d) ? (v || 'N/A') : d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }); };
    const geminiResetHM = fmtHM(g5h?.resetTime);
    const claudeExhausted = [c5hFrac < 0.02 ? c5h : null, cWeeklyFrac < 0.02 ? cWeekly : null].filter(Boolean);
    const claudeResumeBucket = claudeExhausted.length ? claudeExhausted.sort((a, b) => new Date(b.resetTime) - new Date(a.resetTime))[0] : c5h;
    const claudeResetHM = fmtHM(claudeResumeBucket?.resetTime);

    // Il team torna operativo non appena si resetta il PRIMO tra Gemini (se weekly > 2%) e Claude
    const candidateResets = [];
    if (gWeeklyFrac > 0.02 && g5h?.resetTime) candidateResets.push(new Date(g5h.resetTime));
    if (cWeeklyFrac > 0.02 && claudeResumeBucket?.resetTime) candidateResets.push(new Date(claudeResumeBucket.resetTime));
    const earliestWakeDate = candidateResets.filter(d => !isNaN(d)).sort((a, b) => a - b)[0];
    const earliestWakeHM = earliestWakeDate ? fmtHM(earliestWakeDate) : geminiResetHM;

    const tr = routing.updateMode({
      g5h: g5hFrac,
      c5h: c5hFrac,
      cWeekly: cWeeklyFrac,
      resumeAt: earliestWakeHM,
      geminiResetAt: geminiResetHM,
      claudeResetAt: claudeResetHM
    });
    fallbackToClaude = tr.mode === 'claude';
    const resting = tr.mode === 'rest';
    if (tr.changed) {
      let ann = null;
      const gPct5h = `${(g5hFrac * 100).toFixed(1)}%`;
      const gPctW = `${(gWeeklyFrac * 100).toFixed(1)}%`;
      const cPct5h = `${(c5hFrac * 100).toFixed(1)}%`;
      const cPctW = `${(cWeeklyFrac * 100).toFixed(1)}%`;

      if (tr.mode === 'claude' && tr.prev !== 'rest') {
        ann = {
          t: `⚡ **Passaggio automatico agli Alterego Claude**\n\n• 🤖 **Gemini (Primari):** 5h al \`${gPct5h}\` (esaurito) | Settimanale al \`${gPctW}\` -> **Si riattiva alle ore ${geminiResetHM}**\n• 🧠 **Claude (Alterego):** 5h al \`${cPct5h}\` | Settimanale al \`${cPctW}\` (reset 5h: ore **${claudeResetHM}**)\n\nI canali e la dashboard restano invariati: rispondono ora gli Alterego Claude.`,
          c: 0xbc8cff
        };
      } else if (tr.mode === 'rest') {
        ann = {
          t: `💤 **Tutti gli agenti sono in pausa (Quote 5h esaurite)**\n\n• 🤖 **Gemini (Primari):** 5h al \`${gPct5h}\` | Settimanale al \`${gPctW}\` -> ⏰ **Si riattiva alle ore ${geminiResetHM}**\n• 🧠 **Claude (Alterego):** 5h al \`${cPct5h}\` | Settimanale al \`${cPctW}\` -> ⏰ **Si riattiva alle ore ${claudeResetHM}**\n\n✅ **Prossimo risveglio automatico della squadra:** ore **${earliestWakeHM}** (ripartirà automaticamente il primo modello che si ricarica).`,
          c: 0xda3633
        };
      } else {
        const queuedTasks = tr.prev === 'rest' ? routing.flushRestQueue() : [];
        const activeLabel = tr.mode === 'gemini' ? `🤖 **Agenti Primari Gemini** (5h: \`${gPct5h}\`, Settimanale: \`${gPctW}\`)` : `🧠 **Alterego Claude** (5h: \`${cPct5h}\`, Settimanale: \`${cPctW}\`)`;
        ann = {
          t: `🟢 **Quota ripristinata — Squadra di nuovo operativa!**\n\n• **Modello attivo ora:** ${activeLabel}\n• 🤖 **Gemini:** 5h \`${gPct5h}\` (reset **${geminiResetHM}**) | Settimanale \`${gPctW}\`\n• 🧠 **Claude:** 5h \`${cPct5h}\` (reset **${claudeResetHM}**) | Settimanale \`${cPctW}\`${queuedTasks.length > 0 ? `\n\n🚀 **Avvio automatico di ${queuedTasks.length} task in coda dal periodo di riposo!**` : ''}`,
          c: 0x2ea043
        };
        if (queuedTasks.length > 0) {
          setTimeout(() => {
            for (const qt of queuedTasks) {
              const targetAg = TEAM.find(a => a.id === Number(qt.agentId)) || TEAM[0];
              dispatchRealTask(targetAg, qt.text);
            }
          }, 1500);
        }
      }
      try { sendDiscordAnnouncement(ann.t, ann.c, tr.mode); } catch {}
      broadcast({ type: 'agentModeChange', mode: tr.mode, message: ann.t });
      isLoungeBreakActive = (tr.mode === 'rest');
      broadcast({ type: 'loungeBreakState', active: tr.mode === 'rest', reason: tr.mode === 'rest' ? 'quota_rest' : 'quota_resumed' });
    }
    const subagentsList = [];
    for (const [sid, agentId] of Object.entries(SUBAGENT_MAP)) {
      const agent = TEAM.find(a => a.id === agentId);
      let modelDisplayName = agentId === 10 ? 'Gemini 3.8 Flash (Low)' : 'Gemini 3.8 Flash (Tiered)';
      if (resting) {
        modelDisplayName = 'A RIPOSO (quota esaurita)';
      } else if (fallbackToClaude) {
        modelDisplayName = (agentId === 10 ? 'Claude Sonnet 5.5 (Low)' : 'Claude Sonnet 5.5 (Medium)') + ' [ALTEREGO ATTIVO]';
      }
      subagentsList.push({
        id: agentId,
        name: agent ? agent.name : `Agente ${agentId}`,
        model: modelDisplayName,
        subagentId: sid
      });
    }

    lastQuotaData = {
      gemini: {
        fiveHour: `${(g5hFrac * 100).toFixed(1)}%`,
        fiveHourFraction: g5hFrac,
        weekly: `${(gWeeklyFrac * 100).toFixed(1)}%`,
        weeklyFraction: gWeeklyFrac,
        reset5h: g5h?.resetTime || 'N/A',
        resetWeekly: gWeekly?.resetTime || 'N/A'
      },
      claude: {
        fiveHour: `${(c5hFrac * 100).toFixed(1)}%`,
        fiveHourFraction: c5hFrac,
        weekly: `${(cWeeklyFrac * 100).toFixed(1)}%`,
        weeklyFraction: cWeeklyFrac,
        isFallbackActive: fallbackToClaude,
        reset5h: c5h?.resetTime || 'N/A',
        resetWeekly: cWeekly?.resetTime || 'N/A'
      },
      fallbackToClaude,
      mode: tr.mode,
      resting,
      restMessage: resting ? routing.restMessage() : null,
      subagents: subagentsList,
      timestamp: new Date().toISOString()
    };

    return lastQuotaData;
  } catch (err) {
    console.warn('[Telemetry Quota] Errore lettura quote:', err.message);
    return lastQuotaData;
  }
}

// Endpoint API REST per ottenere le quote live reali
app.get('/api/quota', async (req, res) => {
  const data = await getLiveQuotaAndModels();
  if (data) {
    res.json({ ok: true, data });
  } else {
    res.status(503).json({ ok: false, error: 'Language server offline o non raggiungibile' });
  }
});

// Broadcast periodico telemetria quote via WebSocket e su Discord #📊-monitor-usage
setInterval(async () => {
  const data = await getLiveQuotaAndModels();
  if (data) {
    broadcast({
      type: 'liveQuotaUpdate',
      quota: data
    });
    try {
      await updateDiscordUsageMonitor(data);
    } catch {}
  }
}, 8000);

function getAgentActualTokens(sid) {
  const transcriptPath = path.join(BRAIN_DIR, sid, '.system_generated', 'logs', 'transcript.jsonl');
  if (!fs.existsSync(transcriptPath)) return { used: 0, max: 200000 };
  try {
    const stats = fs.statSync(transcriptPath);
    // Leggi gli ultimi 32KB del file per trovare l'ultimo step con i token reali
    const readSize = Math.min(stats.size, 32768);
    const buf = Buffer.alloc(readSize);
    const fd = fs.openSync(transcriptPath, 'r');
    fs.readSync(fd, buf, 0, readSize, stats.size - readSize);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(lines[i]);
        if (parsed.input_tokens !== undefined) {
          const inp = Number(parsed.input_tokens) || 0;
          const out = Number(parsed.output_tokens) || 0;
          return { used: inp + out, max: 200000 };
        }
      } catch {}
    }
  } catch {}
  return { used: 0, max: 200000 };
}

// Upgrade WebSocket su /ws e /terminal
server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
  if (pathname === '/ws' || pathname.startsWith('/ws') || pathname.startsWith('/terminal')) {
    wss.handleUpgrade(request, socket, head, ws => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

// Gestione Connessione Client
wss.on('connection', (ws, req) => {
  const urlPath = new URL(req.url, `http://${req.headers.host}`).pathname;
  console.log(`🔌 [WebSocket] Nuovo client connesso su: ${urlPath}`);

  ws.on('error', err => {
    console.warn(`[WebSocket Client Error ${urlPath}]:`, err.message);
  });

  // Inizializza immediatamente il client
  sendOfficeInitProtocol(ws);

  ws.on('message', message => {
    try {
      const data = JSON.parse(message);
      
      if (data.type === 'webviewReady') {
        sendOfficeInitProtocol(ws);
      } else if (data.type === 'focusAgent') {
        const targetId = Number(data.id);
        const agent = TEAM.find(a => a.id === targetId);
        if (agent) {
          const logLine = `[${new Date().toLocaleTimeString()}] Focus su ${agent.name} (Postazione: ${agent.seatId})`;
          agent.logs.push(logLine);
          
          // Rispondi alla webview con conferma selezione e stato
          ws.send(JSON.stringify({ type: 'agentSelected', id: targetId, agentId: targetId }));
          broadcast({
            type: 'agentFocused',
            id: targetId,
            agentId: targetId,
            agent: agent,
            log: logLine
          });
        }
      } else if (data.type === 'setDiscordWebhook') {
        const url = (data.webhookUrl || '').trim();
        setDiscordWebhook(url);
        broadcast({
          type: 'discordStatus',
          enabled: Boolean(url.startsWith('https://discord.com/api/webhooks/'))
        });
      } else if (data.type === 'executeTask' || data.type === 'userCommand') {
        const targetId = Number(data.agentId) || 10;
        const text = data.prompt || data.command || '';
        const agent = TEAM.find(a => a.id === targetId) || TEAM[0];
        
        // Inoltra l'istruzione reale tramite Command Bridge Reale
        if (!routing.isResting()) {
          isLoungeBreakActive = false;
          broadcast({ type: 'loungeBreakState', active: false, reason: 'task_dispatched' });
        }
        dispatchRealTask(agent, text);
      } else if (data.type === 'toggleLoungeBreak' || data.type === 'breakMode') {
        const active = Boolean(data.active);
        const specificAgentId = (data.agentId !== undefined && data.agentId !== null) ? Number(data.agentId) : null;
        
        let targetAgentIds = [];
        if (specificAgentId) {
          // 1. Pausa mirata su singolo agente specifico
          targetAgentIds = [specificAgentId];
        } else if (active && !routing.isResting()) {
          // 2. Se non specificato, applica la pausa unicamente agli agenti non occupati (idle)
          const currentQueue = loadTaskQueue();
          const busyIds = new Set();
          currentQueue.forEach(t => {
            if (t.status === 'dispatched' || t.status === 'running') {
              busyIds.add(Number(t.agentId));
            }
          });
          TEAM.forEach(a => {
            if (!busyIds.has(a.id) && a.status !== 'working') {
              targetAgentIds.push(a.id);
            }
          });
        } else {
          // 3. Se rientro (active=false) o riposo globale per quote esaurite (rest)
          targetAgentIds = TEAM.map(a => a.id);
        }

        isLoungeBreakActive = active;
        broadcast({
          type: 'loungeBreakState',
          active,
          agentId: specificAgentId,
          agentIds: targetAgentIds,
          reason: specificAgentId ? 'agent_toggle' : (data.reason || 'manual_toggle')
        });
      } else if (data.type === 'callStandupMeeting') {
        const topic = (data.topic || 'Allineamento Architetturale & Sprint Sync').trim();
        broadcast({
          type: 'standupMeetingStarted',
          leaderId: 10,
          leaderName: 'Alberto (CEO)',
          topic,
          time: new Date().toLocaleTimeString()
        });
      } else if (data.type === 'setTargetProject') {
        const res = routing.setTargetProject(data.projectPath);
        if (res.ok) {
          broadcast({
            type: 'targetProjectChanged',
            projectPath: res.projectPath,
            projectName: res.projectName,
            source: 'Web Dashboard'
          });
        } else {
          ws.send(JSON.stringify({ type: 'targetProjectError', error: res.error }));
        }
      } else if (data.type === 'requestPermission') {
        const targetId = Number(data.agentId || data.id) || 10;
        const requestId = data.requestId || `perm_${Date.now()}`;
        const tool = data.tool || 'run_command';
        const command = data.command || 'git push origin main';
        const description = data.description || 'L\'agente richiede autorizzazione prima di procedere.';
        
        // 1. Notifica il terminale laterale e la webview
        broadcast({
          type: 'agentPermissionRequest',
          id: targetId,
          agentId: targetId,
          requestId: requestId,
          tool: tool,
          command: command,
          description: description,
          time: new Date().toLocaleTimeString()
        });

        // 2. Notifica nativa del canvas Pixel Agents per attivare la bolla e l'animazione di alzata di mano/richiesta permesso
        broadcast({
          type: 'agentToolPermission',
          id: targetId,
          agentId: targetId,
          toolId: requestId
        });

        // 3. Notifica interattiva su Discord con bottoni
        sendDiscordPermissionPrompt(requestId, targetId, (TEAM.find(a => a.id === targetId) || TEAM[0]).name, tool, command, description);

        broadcast({
          type: 'agentToolStart',
          id: targetId,
          agentId: targetId,
          toolId: requestId,
          status: `Richiesta approvazione: ${tool}`,
          toolName: tool,
          permissionActive: true
        });
      } else if (data.type === 'permissionResponse') {
        const targetId = Number(data.agentId || data.id) || 10;
        const agent = TEAM.find(a => a.id === targetId) || TEAM[0];
        const isApproved = !!data.approved;
        const logLine = `[${new Date().toLocaleTimeString()}] ${isApproved ? '🟢' : '🔴'} Permesso ${isApproved ? 'AUTORIZZATO' : 'NEGATO'} dall'utente per "${data.tool || 'azione'}"`;
        agent.logs.push(logLine);

        broadcast({
          type: 'permissionResolved',
          agentId: targetId,
          id: targetId,
          requestId: data.requestId,
          approved: isApproved,
          log: logLine
        });

        // Pulisce la bolla di autorizzazione dal canvas nativo
        broadcast({
          type: 'agentToolPermissionClear',
          id: targetId,
          agentId: targetId
        });

        broadcast({
          type: 'agentActivity',
          id: targetId,
          agentId: targetId,
          tool: 'Permission',
          status: `Permesso ${isApproved ? 'Accettato' : 'Rifiutato'}`,
          log: logLine
        });

        if (isApproved) {
          broadcast({
            type: 'agentToolStart',
            id: targetId,
            agentId: targetId,
            toolId: `exec_${Date.now()}`,
            status: `Eseguo: ${data.command || data.tool || 'operazione autorizzata'}`,
            toolName: data.tool || 'Command'
          });
        } else {
          broadcast({
            type: 'agentToolsClear',
            id: targetId,
            agentId: targetId
          });
          broadcast({
            type: 'agentStatus',
            id: targetId,
            agentId: targetId,
            status: 'waiting'
          });
        }
      }
    } catch (err) {
      console.error('[WebSocket] Errore parsing messaggio:', err.message);
    }
  });
});

// REST API per stato e log
app.get('/api/team', (req, res) => {
  res.json({ team: TEAM });
});

app.get('/api/project', (req, res) => {
  const cur = routing.getTargetProject();
  res.json({ projectPath: cur, projectName: path.basename(cur) });
});

app.post('/api/project', (req, res) => {
  const { projectPath } = req.body || {};
  const result = routing.setTargetProject(projectPath);
  if (!result.ok) {
    return res.status(400).json({ ok: false, error: result.error });
  }
  broadcast({
    type: 'targetProjectChanged',
    projectPath: result.projectPath,
    projectName: result.projectName,
    source: 'REST API'
  });
  res.json(result);
});

app.get('/api/tasks/queue', (req, res) => {
  res.json({ queue: loadTaskQueue(), mode: routing.getMode() });
});

app.post('/api/tasks/clear', (req, res) => {
  const { filter } = req.body || {};
  let current = loadTaskQueue();
  if (filter === 'completed') {
    current = current.filter(t => t.status !== 'completed' && t.status !== 'failed');
  } else {
    current = [];
  }
  saveTaskQueue(current);
  res.json({ success: true, queue: current });
});

app.post('/api/ceo-report', (req, res) => {
  const { postToDiscord } = req.body || {};
  const projPath = routing.getTargetProject() || WORKSPACE_DIR;
  const bin = process.platform === 'win32' ? 'git.exe' : 'git';
  execFile(bin, ['log', '-n', '6', '--oneline'], { cwd: projPath, timeout: 8000, windowsHide: true }, (err, stdout) => {
    const gitCommits = (stdout || '').trim() || 'Nessun commit recente rilevato.';
    const tasks = loadTaskQueue();
    const completed = tasks.filter(t => t.status === 'completed');
    const active = tasks.filter(t => t.status === 'dispatched' || t.status === 'running');
    const queued = tasks.filter(t => t.status === 'queued_rest' || t.status === 'queued');
    const mode = routing.getMode();
    const g5h = lastQuotaData?.gemini?.fiveHour || '100%';
    const gWk = lastQuotaData?.gemini?.weekly || '100%';
    const c5h = lastQuotaData?.claude?.fiveHour || '100%';
    const cWk = lastQuotaData?.claude?.weekly || '100%';
    const nowStr = new Date().toLocaleString('it-IT');

    const reportMd = [
      `# 📊 Report Esecutivo CEO — AziendaAI`,
      `**Data & Ora:** ${nowStr}`,
      `**Progetto Target Attivo:** \`${projPath}\``,
      `**Modalità Operativa:** \`${mode.toUpperCase()}\``,
      ``,
      `## 🧠 Telemetria Quote Antigravity`,
      `- **🤖 Gemini (Flash / Pro):** 5h: \`${g5h}\` | Settimanale: \`${gWk}\``,
      `- **🧠 Claude (Alterego Fallback):** 5h: \`${c5h}\` | Settimanale: \`${cWk}\``,
      ``,
      `## 👥 Stato Squadra`,
      ...TEAM.map(a => {
        const lastLog = (a.logs && a.logs.length > 0) ? a.logs[a.logs.length - 1] : 'Pronto';
        return `- **${a.avatar || '🤖'} ${a.name}** (*${a.role}*): ${lastLog}`;
      }),
      ``,
      `## 📋 Riepilogo Lavagna Kanban`,
      `- **✅ Completati:** ${completed.length} | **⚡ In Corso:** ${active.length} | **⏳ In Coda:** ${queued.length}`,
      ...(completed.slice(-5).reverse().map(t => `  - ✔ **[${t.agentName}]** \`${(t.prompt || t.command || '').slice(0, 80)}\``)),
      ``,
      `## 🐙 Ultimi Commit Git (${path.basename(projPath)})`,
      '```text',
      gitCommits,
      '```'
    ].join('\n');

    if (postToDiscord) {
      try {
        sendDiscordAnnouncement(reportMd.slice(0, 3900), 0x2ea043);
      } catch {}
    }

    res.json({
      ok: true,
      report: reportMd,
      postedToDiscord: Boolean(postToDiscord),
      stats: { completed: completed.length, active: active.length, queued: queued.length, mode }
    });
  });
});

app.post('/api/permission/request', (req, res) => {
  const { agentId, tool, command, description } = req.body;
  const targetId = Number(agentId) || 10;
  const requestId = `perm_${Date.now()}`;
  const targetName = (TEAM.find(a => a.id === targetId) || TEAM[0]).name;

  broadcast({
    type: 'agentPermissionRequest',
    id: targetId,
    agentId: targetId,
    requestId: requestId,
    tool: tool || 'run_command',
    command: command || 'git push origin main',
    description: description || 'Richiesta autorizzazione per operazione critica.',
    time: new Date().toLocaleTimeString()
  });
  broadcast({
    type: 'agentToolPermission',
    id: targetId,
    agentId: targetId,
    toolId: requestId
  });
  broadcast({
    type: 'agentToolStart',
    id: targetId,
    agentId: targetId,
    toolId: requestId,
    status: `Richiesta approvazione: ${tool || 'run_command'}`,
    toolName: tool || 'run_command',
    permissionActive: true
  });

  // Notifica interattiva su Discord con bottoni
  try {
    sendDiscordPermissionPrompt(requestId, targetId, targetName, tool || 'run_command', command || 'git push origin main', description || 'Richiesta autorizzazione per operazione critica.');
  } catch (err) {
    console.warn('[Discord Bot] Errore invio prompt autorizzazione:', err.message);
  }

  res.json({ success: true, requestId });
});

app.post('/api/log', (req, res) => {
  const { agentId, log, tool } = req.body;
  const targetId = Number(agentId) || 10;
  const agent = TEAM.find(a => a.id === targetId) || TEAM[0];

  const logLine = `[${new Date().toLocaleTimeString()}] ${log || ('Attività: ' + tool)}`;
  agent.logs.push(logLine);

  if (tool) {
    broadcast({
      type: 'agentToolStart',
      id: agent.id,
      toolId: `tool_${Date.now()}`,
      status: `Tool: ${tool}`,
      toolName: tool
    });
  }

  broadcast({
    type: 'agentActivity',
    agentId: agent.id,
    tool: tool,
    log: logLine
  });

  res.json({ success: true, agent: agent.name, log: logLine });
});

// Monitor log transcript da Antigravity per live streaming e animazioni
const filePositions = new Map();
const delegationActiveUntil = new Map();
const SUBAGENT_MAP = routing.allSessionsMap();

function formatToolDesc(call) {
  const args = call.args || {};
  let detail = '';
  if (args.toolSummary) {
    detail = String(args.toolSummary).replace(/^"|"$/g, '').trim();
  } else if (args.Path) {
    detail = path.basename(String(args.Path));
  } else if (args.CommandLine) {
    const cmd = String(args.CommandLine).replace(/^"|"$/g, '').replace(/\r?\n/g, ' ').trim();
    detail = cmd.length > 70 ? cmd.slice(0, 67) + '...' : cmd;
  } else if (args.Message) {
    const m = (typeof args.Message === 'string' ? args.Message : JSON.stringify(args.Message)).replace(/\r?\n/g, ' ').trim();
    detail = m.length > 70 ? m.slice(0, 67) + '...' : m;
  } else if (args.Prompt) {
    const p = (typeof args.Prompt === 'string' ? args.Prompt : JSON.stringify(args.Prompt)).replace(/\r?\n/g, ' ').trim();
    detail = p.length > 70 ? p.slice(0, 67) + '...' : p;
  }
  return detail ? `${call.name} -> ${detail}` : `Eseguo: ${call.name}`;
}

// Pre-carica i log recenti storici dai file transcript di Antigravity
function preloadAgentLogs() {
  if (!fs.existsSync(BRAIN_DIR)) return;
  for (const [sid, agentId] of Object.entries(routing.allSessionsMap())) {
    const sessionPath = path.join(BRAIN_DIR, sid);
    const transcriptPath = path.join(sessionPath, '.system_generated', 'logs', 'transcript.jsonl');
    if (!fs.existsSync(transcriptPath)) continue;
    try {
      const stats = fs.statSync(transcriptPath);
      filePositions.set(transcriptPath, stats.size);
      const readSize = Math.min(stats.size, 65536);
      const buf = Buffer.alloc(readSize);
      const fd = fs.openSync(transcriptPath, 'r');
      fs.readSync(fd, buf, 0, readSize, stats.size - readSize);
      fs.closeSync(fd);
      const lines = buf.toString('utf8').split('\n');
      const targetAgent = TEAM.find(a => a.id === agentId);
      if (!targetAgent) continue;
      const recentLogs = [];
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line.trim());
          if (parsed.type === 'PLANNER_RESPONSE' && parsed.tool_calls) {
            for (const call of parsed.tool_calls) {
              const statusDesc = formatToolDesc(call);
              const timeStr = parsed.created_at ? new Date(parsed.created_at).toLocaleTimeString() : new Date().toLocaleTimeString();
              recentLogs.push(`[${timeStr}] ⚡ ${statusDesc}`);
            }
          }
        } catch {}
      }
      if (recentLogs.length > 0) {
        targetAgent.logs = recentLogs.slice(-25);
      }
    } catch (err) {
      console.warn(`[AziendaAI] Errore caricamento transcript per ${agentId}:`, err.message);
    }
  }
}

preloadAgentLogs();

function monitorLiveAntigravity() {
  if (!fs.existsSync(BRAIN_DIR)) return;
  try {
    for (const [sid, agentId] of Object.entries(routing.allSessionsMap())) {
      const sessionPath = path.join(BRAIN_DIR, sid);
      const transcriptPath = path.join(sessionPath, '.system_generated', 'logs', 'transcript.jsonl');
      if (!fs.existsSync(transcriptPath)) continue;

      try {
        const stats = fs.statSync(transcriptPath);
        if (!filePositions.has(transcriptPath)) {
          filePositions.set(transcriptPath, stats.size);
          continue;
        }

        const prevPos = filePositions.get(transcriptPath);
        if (stats.size > prevPos) {
          const fd = fs.openSync(transcriptPath, 'r');
          const bufferSize = stats.size - prevPos;
          const buffer = Buffer.alloc(bufferSize);
          fs.readSync(fd, buffer, 0, bufferSize, prevPos);
          fs.closeSync(fd);
          filePositions.set(transcriptPath, stats.size);

          const lines = buffer.toString('utf8').split('\n');
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const parsed = JSON.parse(line.trim());
              const targetAgent = TEAM.find(a => a.id === agentId) || TEAM[0];

              // Intercetta messaggi ricevuti da un collega ([Message] sender=<uuid>)
              const contentStr = typeof parsed.content === 'string' ? parsed.content : '';
              if (contentStr.includes('sender=')) {
                const senderMatch = /sender=([a-f0-9\-]+)/i.exec(contentStr);
                if (senderMatch) {
                  const senderUuid = senderMatch[1];
                  const allMap = routing.allSessionsMap();
                  const fromAgentId = allMap[senderUuid];
                  if (fromAgentId && fromAgentId !== agentId) {
                    const fromAgent = TEAM.find(a => a.id === fromAgentId);
                    const contentMatch = /content=([\s\S]*?)(?:<\/SYSTEM_MESSAGE>|$)/i.exec(contentStr);
                    const rawMsg = contentMatch ? contentMatch[1].trim() : contentStr;
                    delegationActiveUntil.set(fromAgentId, Date.now() + 8000);
                    broadcast({
                      type: 'agentDelegation',
                      fromAgentId: fromAgentId,
                      toAgentId: agentId,
                      fromName: fromAgent ? fromAgent.name : `Agente ${fromAgentId}`,
                      toName: targetAgent.name,
                      message: rawMsg
                    });
                  }
                }
              }

              if (parsed.type === 'PLANNER_RESPONSE' && parsed.tool_calls) {
                for (const call of parsed.tool_calls) {
                  const statusDesc = formatToolDesc(call);
                  const timeStr = parsed.created_at ? new Date(parsed.created_at).toLocaleTimeString() : new Date().toLocaleTimeString();
                  const logLine = `[${timeStr}] ⚡ ${statusDesc}`;
                  targetAgent.logs.push(logLine);

                  broadcast({
                    type: 'agentToolStart',
                    id: agentId,
                    agentId: agentId,
                    toolId: `tool_${Date.now()}`,
                    status: statusDesc,
                    toolName: call.name,
                    detail: statusDesc
                  });

                  broadcast({
                    type: 'agentActivity',
                    id: agentId,
                    agentId: agentId,
                    tool: call.name,
                    status: statusDesc,
                    log: logLine
                  });

                  // Rileva quando un agente delega/comunica con un altro collega tramite send_message!
                  if (call.name === 'send_message' && call.args) {
                    const rawRecip = String(call.args.Recipient || '').replace(/^"|"$/g, '').trim();
                    const rawMsg = String(call.args.Message || '').replace(/^"|"$/g, '').trim();
                    const allMap = routing.allSessionsMap();
                    const toAgentId = allMap[rawRecip];
                    if (toAgentId && toAgentId !== agentId) {
                      const destAgent = TEAM.find(a => a.id === toAgentId);
                      delegationActiveUntil.set(agentId, Date.now() + 8000);
                      broadcast({
                        type: 'agentDelegation',
                        fromAgentId: agentId,
                        toAgentId: toAgentId,
                        fromName: targetAgent.name,
                        toName: destAgent ? destAgent.name : `Agente ${toAgentId}`,
                        message: rawMsg
                      });
                    }
                  }
                }
              } else if (parsed.type === 'PLANNER_RESPONSE') {
                // Non emettere agentToolsClear se l'agente sta eseguendo o ha appena eseguito send_message per non interrompere bruscamente la camminata
                const until = delegationActiveUntil.get(agentId) || 0;
                const isDelivering = Date.now() < until;
                if (!isDelivering) {
                  broadcast({ type: 'agentToolsClear', id: agentId, agentId: agentId });
                  broadcast({ type: 'agentStatus', id: agentId, agentId: agentId, status: 'waiting' });
                } else {
                  // Differito: pulisce i tool solo dopo che l'animazione di consegna sul canvas è completata
                  const delay = Math.max(1500, until - Date.now());
                  setTimeout(() => {
                    broadcast({ type: 'agentToolsClear', id: agentId, agentId: agentId });
                    broadcast({ type: 'agentStatus', id: agentId, agentId: agentId, status: 'waiting' });
                  }, delay);
                }

                // Quando l'agente termina e ha generato un messaggio testuale finale, invialo sul canale Discord e via WS alla Dashboard!
                if (parsed.content && typeof parsed.content === 'string' && parsed.content.trim().length > 0) {
                  const finalText = parsed.content.trim();
                  const timeStr = parsed.created_at ? new Date(parsed.created_at).toLocaleTimeString() : new Date().toLocaleTimeString();
                  const logLine = `[${timeStr}] 💬 ${finalText}`;
                  targetAgent.logs.push(logLine);

                  broadcast({
                    type: 'agentActivity',
                    id: agentId,
                    agentId: agentId,
                    tool: 'Response',
                    status: 'In attesa di istruzioni (Idle)',
                    text: finalText,
                    content: finalText,
                    log: logLine
                  });

                  // Segna l'ultimo task dispatched per questo agente come 'completed' con l'esito finale
                  try {
                    const qTasks = loadTaskQueue();
                    for (let i = qTasks.length - 1; i >= 0; i--) {
                      if (Number(qTasks[i].agentId) === Number(agentId) && (qTasks[i].status === 'dispatched' || qTasks[i].status === 'running')) {
                        qTasks[i].status = 'completed';
                        qTasks[i].exitCode = 0;
                        qTasks[i].output = finalText.slice(0, 600);
                        saveTaskQueue(qTasks);
                        break;
                      }
                    }
                  } catch {}

                  // Se un collega (Luigi, Gabri, Carlo) ha completato il suo lavoro o menziona un altro collega, cammina fisicamente verso di lui (o verso Alberto CEO) per consegnare il risultato!
                  if (agentId !== 10) {
                    const lowerResp = finalText.toLowerCase();
                    let reportTargetId = 10; // Di default riporta il risultato ad Alberto (CEO)
                    for (const member of TEAM) {
                      if (member.id !== agentId && member.id !== 10) {
                        const kw = (member.name || '').toLowerCase().split(' ')[0];
                        if (kw && lowerResp.includes(kw)) {
                          reportTargetId = member.id;
                          break;
                        }
                      }
                    }
                    const destMember = TEAM.find(a => a.id === reportTargetId) || TEAM[0];
                    broadcast({
                      type: 'agentDelegation',
                      fromAgentId: agentId,
                      toAgentId: destMember.id,
                      fromName: targetAgent.name,
                      toName: destMember.name,
                      message: finalText
                    });
                  }

                  sendFinalAgentResponse(agentId, finalText);
                }
              }

              // Calcola e trasmette l'uso token contestuale reale esatto dell'ultimo step
              const actualTok = getAgentActualTokens(sid);
              broadcast({
                type: 'agentContextUsage',
                id: agentId,
                agentId: agentId,
                contextTokens: actualTok.used,
                maxContextTokens: actualTok.max
              });
            } catch {}
          }
        }
      } catch {}
    }
  } catch {}
}

setInterval(monitorLiveAntigravity, 600);

// Fallback SPA per tutte le route non API
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/ws')) return next();
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

server.listen(PORT, () => {
  console.log('================================================================');
  console.log(`  🏢 AZIENDA AI OFFICE - SALA OPERATIVA NATIVA`);
  console.log(`  🌐 Dashboard Web: http://localhost:${PORT}`);
  console.log(`  ⚡ WebSocket Server: ws://localhost:${PORT}/ws`);
  console.log(`  👥 Agenti Permanenti: Alberto (10), Luigi (6), Gabri (7), Carlo (8)`);
  console.log('================================================================');

  // Avvio Bot Discord Ufficiale
  try {
    initDiscordBot((action) => {
      if (action.type === 'permissionResponseFromDiscord') {
        const targetId = Number(action.agentId) || 10;
        const agent = TEAM.find(a => a.id === targetId) || TEAM[0];
        const isApproved = !!action.approved;
        const logLine = `[${new Date().toLocaleTimeString()}] ${isApproved ? '🟢' : '🔴'} Permesso ${isApproved ? 'AUTORIZZATO' : 'NEGATO'} da Discord`;
        agent.logs.push(logLine);

        broadcast({
          type: 'permissionResolved',
          agentId: targetId,
          id: targetId,
          requestId: action.requestId,
          approved: isApproved,
          log: logLine
        });

        broadcast({
          type: 'agentToolPermissionClear',
          id: targetId,
          agentId: targetId
        });

        broadcast({
          type: 'agentActivity',
          id: targetId,
          agentId: targetId,
          tool: 'Discord Permission',
          status: `Permesso da Discord: ${isApproved ? 'Accettato' : 'Rifiutato'}`,
          log: logLine
        });
      } else {
        broadcast(action);
      }
    });
  } catch (err) {
    console.warn('[Discord Bot] Avvio differito o non riuscito:', err.message);
  }
});

