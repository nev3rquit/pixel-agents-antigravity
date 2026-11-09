/**
 * ghost-workspace.js — Ghost Workspace in Docker & Isolated Sandbox (Idea #6)
 * Permette ad AziendaAI di testare codice, dipendenze o comandi rischiosi in un
 * container Docker effimero o in una cartella di sandbox isolata senza sporcare né
 * compromettere il workspace principale.
 */

const { execFile, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const GHOST_ROOT = path.join(os.homedir(), '.gemini', 'antigravity', 'ghost_sandboxes');

// Assicura che la directory per i ghost sandbox esista
try {
  if (!fs.existsSync(GHOST_ROOT)) {
    fs.mkdirSync(GHOST_ROOT, { recursive: true });
  }
} catch (_) {}

// File segreti mai copiati nella sandbox
const SECRET_FILE_RE = /^(\.env.*|discord\.config\.json|agents\.config\.json|team\.config\.json|crash\.log|.*\.(pem|key|pfx)|.*token.*|.*secret.*|id_rsa.*)$/i;

// Sweep all'avvio: elimina sandbox residue
try {
  for (const d of fs.readdirSync(GHOST_ROOT)) {
    if (d.startsWith('ghost_')) fs.rmSync(path.join(GHOST_ROOT, d), { recursive: true, force: true });
  }
} catch (_) {}

const LOCAL_ALLOWED_BINS = new Set(['node', 'git', 'python', 'python3']);

// Tokenizer quote-aware: nessuna shell coinvolta => nessuna command injection
function tokenizeCommand(cmd) {
  const tokens = [];
  let cur = '', quote = null, has = false;
  for (const ch of cmd) {
    if (quote) {
      if (ch === quote) quote = null; else cur += ch;
    } else if (ch === '"' || ch === "'") { quote = ch; has = true; }
    else if (/\s/.test(ch)) { if (has || cur) { tokens.push(cur); cur = ''; has = false; } }
    else { cur += ch; }
  }
  if (quote) return null;
  if (has || cur) tokens.push(cur);
  return tokens;
}

// Valida projectPath: directory esistente, senza caratteri che alterano il mount docker
function validateProjectPath(p) {
  const resolved = path.resolve(String(p || process.cwd()));
  if (/[\0\r\n,"]/.test(resolved) || resolved.slice(2).includes(':')) throw new Error('projectPath non valido');
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) throw new Error("projectPath non e' una directory esistente");
  return resolved;
}

function sanitizeImageName(image) {
  if (!image || typeof image !== 'string') return 'node:alpine';
  const trimmed = image.trim();
  // Valid docker image regex: optional registry/namespace, repository name, optional tag or digest
  // Stretto: nome minuscolo che inizia con alfanumerico, opzionale namespace e tag (es. node:alpine)
  const validPattern = /^[a-z0-9][a-z0-9_.-]*(?:\/[a-z0-9][a-z0-9_.-]*)*(?::[a-zA-Z0-9][a-zA-Z0-9_.-]*)?$/;
  if (!validPattern.test(trimmed) || trimmed.length > 128) {
    return 'node:alpine';
  }
  return trimmed;
}

/**
 * Controlla se Docker è installato e se il daemon è attualmente attivo.
 */
function checkDockerStatus() {
  return new Promise((resolve) => {
    execFile('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 4000, windowsHide: true }, (err, stdout) => {
      if (err) {
        return resolve({
          available: false,
          version: null,
          engine: 'local-ghost',
          status: 'Docker non disponibile o daemon arrestato. Fallback su Ghost Sandbox Locale attivo.'
        });
      }
      resolve({
        available: true,
        version: (stdout || '').trim(),
        engine: 'docker',
        status: `Docker Daemon attivo (v${(stdout || '').trim()})`
      });
    });
  });
}

/**
 * Esegue un comando all'interno del Ghost Sandbox.
 * Se Docker è disponibile, avvia un container effimero (`docker run --rm`).
 * Altrimenti, clona i file rilevanti in un sandbox isolato temporaneo ed esegue lì.
 */
async function executeGhostCommand({ command, projectPath, imageName = 'node:alpine', timeoutMs = 30000 }) {
  const startTime = Date.now();
  const cleanCmd = String(command || '').trim();
  let targetDir;
  try { targetDir = validateProjectPath(projectPath); } catch (e) { return { success: false, exitCode: 1, output: 'Ghost: ' + e.message, engine: 'none', durationMs: 0 }; }
  const safeImageName = sanitizeImageName(imageName);
  const parsedTimeout = Math.min(Math.max(Number(timeoutMs) || 30000, 1000), 120000);

  if (!cleanCmd) {
    return {
      success: false,
      exitCode: 1,
      output: 'Nessun comando fornito per il Ghost Workspace.',
      engine: 'none',
      durationMs: 0
    };
  }

  const dockerStatus = await checkDockerStatus();

  if (dockerStatus.available) {
    // Esecuzione in Container Docker Isolato
    // Monta la cartella del progetto in sola lettura (/workspace:ro) o in volume temporaneo
    return new Promise((resolve) => {
      // Normalizzazione del path Windows per Docker (es. C:\foo -> //c/foo o c:/foo)
      const dockerPath = targetDir.replace(/\\/g, '/');
      const containerName = `ghost_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      const dockerArgs = [
        'run',
        '--rm',
        '--name', containerName,
        '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        '--read-only', '--tmpfs', '/tmp', '--pids-limit', '128', '--memory', '256m', '--cpus', '1',
        '--user', '1000:1000',
        '-v', `${dockerPath}:/workspace:ro`,
        '-w', '/workspace',
        '--',
        safeImageName,
        'sh', '-c', cleanCmd
      ];

      execFile('docker', dockerArgs, { timeout: parsedTimeout, windowsHide: true }, (err, stdout, stderr) => {
        if (err && (err.killed || err.signal === 'SIGTERM')) {
          try { execFile('docker', ['rm', '-f', containerName], { timeout: 10000, windowsHide: true }, () => {}); } catch (_) {}
        }
        const durationMs = Date.now() - startTime;
        const exitCode = err ? (err.code || 1) : 0;
        const isTimeout = err && (err.killed || err.signal === 'SIGTERM' || durationMs >= parsedTimeout);
        let out = (stdout || stderr || (err ? err.message : '')).trim();
        if (isTimeout) {
          out = `[TIMEOUT] Esecuzione interrotta dopo ${parsedTimeout}ms.\n${out}`.trim();
        }

        resolve({
          success: exitCode === 0 && !isTimeout,
          exitCode: isTimeout ? 124 : exitCode,
          output: out || (exitCode === 0 ? 'Comando Ghost completato nel container con successo.' : 'Errore esecuzione container.'),
          engine: 'docker',
          containerImage: safeImageName,
          durationMs
        });
      });
    });
  } else {
    // Modalità Fallback: Ghost Sandbox Isolato su Filesystem Locale
    return new Promise((resolve) => {
      const sandboxId = `ghost_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      const sandboxDir = path.join(GHOST_ROOT, sandboxId);

      try {
        fs.mkdirSync(sandboxDir, { recursive: true });
        
        // Copia leggera dei soli file manifest e config (package.json, js, ecc.) senza node_modules pesanti
        copyShallowProject(targetDir, sandboxDir);

        // Docker spento: SOLO comandi git di sola lettura (status/diff/log), senza shell
        const argv = tokenizeCommand(cleanCmd);
        const RO_GIT = new Set(['status', 'diff', 'log']);
        const argOk = (a) => /^[A-Za-z0-9_.\/\\:=@~^,-]+$/.test(a) && !/^--?(output|ext-diff|textconv|exec|open-files|upload-pack|c$)/i.test(a);
        if (!argv || argv.length < 2 || argv[0] !== 'git' || !RO_GIT.has(argv[1]) || !argv.slice(2).every(argOk)) {
          try { fs.rmSync(sandboxDir, { recursive: true, force: true }); } catch (_) {}
          return resolve({ success: false, exitCode: 126, output: 'Esecuzione protetta Ghost richiede Docker Desktop attivo. Senza Docker sono consentiti solo comandi di sola lettura: git status, git diff, git log.', engine: 'local-ghost', sandboxId, durationMs: Date.now() - startTime });
        }
        const safeEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull, GIT_OPTIONAL_LOCKS: '0', GHOST_SANDBOX: '1' };
        // git deve leggere il repo reale in sola lettura: cwd = progetto reale
        execFile('git', ['--no-pager', ...argv.slice(1)], {
          cwd: targetDir,
          timeout: parsedTimeout,
          windowsHide: true,
          env: safeEnv,
        }, (err, stdout, stderr) => {
          const durationMs = Date.now() - startTime;
          const exitCode = err ? (err.code || 1) : 0;
          const isTimeout = err && (err.killed || err.signal === 'SIGTERM' || durationMs >= parsedTimeout);
          let out = (stdout || stderr || (err ? err.message : '')).trim();
          if (isTimeout) {
            out = `[TIMEOUT] Esecuzione sandbox locale interrotta dopo ${parsedTimeout}ms.\n${out}`.trim();
          }

          // Pulizia immediata della sandbox temporanea
          try {
            fs.rmSync(sandboxDir, { recursive: true, force: true });
          } catch (_) {}

          resolve({
            success: exitCode === 0 && !isTimeout,
            exitCode: isTimeout ? 124 : exitCode,
            output: out || (exitCode === 0 ? 'Ghost Sandbox Locale: esecuzione terminata con successo.' : 'Errore esecuzione sandbox locale.'),
            engine: 'local-ghost',
            sandboxId: sandboxId,
            durationMs
          });
        });
      } catch (err) {
        resolve({
          success: false,
          exitCode: 1,
          output: `Errore inizializzazione Ghost Sandbox: ${err.message}`,
          engine: 'local-ghost',
          durationMs: Date.now() - startTime
        });
      }
    });
  }
}

/**
 * Helper per copiare i file di base nel sandbox isolato escludendo cartelle giganti (.git, node_modules)
 */
function copyShallowProject(src, dest) {
  try {
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
      if (SECRET_FILE_RE.test(entry.name) || entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist' || entry.name === 'scratch') {
        continue;
      }
      const sPath = path.join(src, entry.name);
      const dPath = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        fs.mkdirSync(dPath, { recursive: true });
        // Copia a profondità 1 o 2 per mantenere la struttura cartelle
        try {
          const subEntries = fs.readdirSync(sPath, { withFileTypes: true });
          for (const sub of subEntries) {
            if (sub.isFile() && !SECRET_FILE_RE.test(sub.name)) {
              fs.copyFileSync(path.join(sPath, sub.name), path.join(dPath, sub.name));
            }
          }
        } catch (_) {}
      } else if (entry.isFile()) {
        fs.copyFileSync(sPath, dPath);
      }
    }
  } catch (_) {}
}

module.exports = {
  checkDockerStatus,
  executeGhostCommand,
  GHOST_ROOT
};
