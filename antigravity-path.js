// Risoluzione cross-platform dell'eseguibile language_server di Antigravity.
//
// Ordine di ricerca:
//   1. ANTIGRAVITY_LS_PATH  -> percorso esplicito dell'eseguibile
//   2. ANTIGRAVITY_HOME     -> cartella di installazione (contiene resources/bin/)
//   3. Percorsi di installazione standard per piattaforma
//   4. Launcher `antigravity` nel PATH (risolve il symlink fino all'installazione)
//   5. (Linux) processo language_server di Antigravity attualmente in esecuzione
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const IS_WIN = process.platform === 'win32';
const LS_NAME = IS_WIN ? 'language_server.exe' : 'language_server';

function binIn(installDir) {
  return path.resolve(installDir, 'resources', 'bin', LS_NAME);
}

function isExecutable(p) {
  try {
    fs.accessSync(p, IS_WIN ? fs.constants.F_OK : fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function standardInstallDirs() {
  if (IS_WIN) {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return [path.join(local, 'Programs', 'antigravity')];
  }
  return [
    '/usr/share/antigravity',
    '/opt/antigravity',
    '/opt/Antigravity',
    path.join(os.homedir(), '.local', 'share', 'antigravity'),
    path.join(os.homedir(), 'Applications', 'antigravity')
  ];
}

// Il launcher di Antigravity e' tipicamente <install>/bin/antigravity oppure <install>/antigravity
function installDirsFromPath() {
  const dirs = [];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const name of IS_WIN ? ['antigravity.cmd', 'antigravity.exe'] : ['antigravity']) {
      try {
        const real = fs.realpathSync(path.join(dir, name));
        const parent = path.dirname(real);
        dirs.push(parent, path.dirname(parent));
      } catch {}
    }
  }
  return dirs;
}

// Fallback Linux: individua il language_server avviato dall'IDE tramite /proc
function runningLanguageServer() {
  if (process.platform !== 'linux') return null;
  try {
    for (const pid of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(pid)) continue;
      try {
        const exe = fs.readlinkSync(`/proc/${pid}/exe`);
        if (path.basename(exe) === LS_NAME && exe.includes(`${path.sep}resources${path.sep}bin${path.sep}`)) {
          return exe;
        }
      } catch {}
    }
  } catch {}
  return null;
}

let cached = null;

function resolveLanguageServer() {
  if (cached && isExecutable(cached)) return cached;

  const candidates = [];
  if (process.env.ANTIGRAVITY_LS_PATH) candidates.push(path.resolve(process.env.ANTIGRAVITY_LS_PATH));
  if (process.env.ANTIGRAVITY_HOME) candidates.push(binIn(process.env.ANTIGRAVITY_HOME));
  for (const d of standardInstallDirs()) candidates.push(binIn(d));
  for (const d of installDirsFromPath()) candidates.push(binIn(d));

  for (const c of candidates) {
    if (isExecutable(c)) return (cached = c);
  }

  const running = runningLanguageServer();
  if (running && isExecutable(running)) return (cached = running);

  // Nessun risultato: restituisce il primo candidato per messaggi d'errore leggibili
  return candidates[0];
}

// Il language_server in modalita' agentapi richiede l'indirizzo e il token CSRF
// dell'istanza di Antigravity in esecuzione. Nel terminale integrato di Antigravity
// sono gia' presenti; altrimenti vengono letti da ~/.gemini/antigravity/daemon/hub_*.json.
const DAEMON_DIR = path.join(os.homedir(), '.gemini', 'antigravity', 'daemon');

function probeDaemon(cfg) {
  return new Promise(resolve => {
    const body = '{}';
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
    }, res => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end(body);
  });
}

async function getLanguageServerEnv(baseEnv = process.env) {
  const env = Object.assign({}, baseEnv);
  if (env.ANTIGRAVITY_LS_ADDRESS && env.ANTIGRAVITY_CSRF_TOKEN) return env;
  try {
    const hubs = fs.readdirSync(DAEMON_DIR)
      .filter(f => f.startsWith('hub_') && f.endsWith('.json'))
      .map(f => path.join(DAEMON_DIR, f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    for (const h of hubs) {
      try {
        const cfg = JSON.parse(fs.readFileSync(h, 'utf8'));
        if (cfg.httpPort && cfg.csrfToken && await probeDaemon(cfg)) {
          env.ANTIGRAVITY_LS_ADDRESS = `127.0.0.1:${cfg.httpPort}`;
          env.ANTIGRAVITY_CSRF_TOKEN = cfg.csrfToken;
          return env;
        }
      } catch {}
    }
  } catch {}
  return null;
}

// Elenco dei modelId abilitati per l'account corrente (vuoto se la RPC non risponde)
function listAvailableModels(env) {
  return new Promise(resolve => {
    const port = String(env.ANTIGRAVITY_LS_ADDRESS || '').split(':').pop();
    const body = '{}';
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/exa.language_server_pb.LanguageServerService/GetCascadeModelConfigData',
      method: 'POST',
      timeout: 3000,
      headers: {
        'Content-Type': 'application/json',
        'x-codeium-csrf-token': env.ANTIGRAVITY_CSRF_TOKEN,
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          const cfgs = JSON.parse(raw).clientModelConfigs || [];
          resolve(cfgs.filter(m => m.modelId && !m.disabled).map(m => ({ id: m.modelId, label: m.label })));
        } catch { resolve([]); }
      });
    });
    req.on('error', () => resolve([]));
    req.on('timeout', () => { req.destroy(); resolve([]); });
    req.end(body);
  });
}

module.exports = { resolveLanguageServer, getLanguageServerEnv, listAvailableModels };
