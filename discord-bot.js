const { Client, GatewayIntentBits, Partials, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const routing = require('./routing');
const { resolveLanguageServer } = require('./antigravity-path');

const DAEMON_DIR = path.join(os.homedir(), '.gemini', 'antigravity', 'daemon');
let cachedDaemonConfig = null;

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

const CONFIG_PATH = path.join(__dirname, 'discord.config.json');
let BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || '';
try {
  if (fs.existsSync(CONFIG_PATH)) {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (cfg.botToken) BOT_TOKEN = cfg.botToken;
  }
} catch (_) {}

const SUBAGENT_CHANNELS = {
  'alberto-ceo': { id: 10, channelKeyword: 'alberto', subagentId: routing.PRIMARY[10], name: 'Alberto (CEO)', color: 0x58a6ff },
  'luigi-backend': { id: 6, channelKeyword: 'luigi', subagentId: routing.PRIMARY[6], name: 'Luigi (Backend)', color: 0x2ea043 },
  'gabri-frontend': { id: 7, channelKeyword: 'gabri', subagentId: routing.PRIMARY[7], name: 'Gabri (Frontend)', color: 0xbc8cff },
  'carlo-qa': { id: 8, channelKeyword: 'carlo', subagentId: routing.PRIMARY[8], name: 'Carlo (QA & Security)', color: 0xd29922 }
};
try {
  const teamCfgPath = path.join(__dirname, 'team.config.json');
  if (fs.existsSync(teamCfgPath)) {
    const customTeam = JSON.parse(fs.readFileSync(teamCfgPath, 'utf8'));
    if (Array.isArray(customTeam) && customTeam.length > 0) {
      for (const k of Object.keys(SUBAGENT_CHANNELS)) delete SUBAGENT_CHANNELS[k];
      for (const m of customTeam) {
        const key = m.key || `agent-${m.id}`;
        SUBAGENT_CHANNELS[key] = {
          id: Number(m.id),
          channelKeyword: (m.channelKeyword || m.name || '').toLowerCase().split(' ')[0],
          subagentId: routing.PRIMARY[Number(m.id)],
          name: m.name || `Agent ${m.id}`,
          color: Number(m.color) || 0x58a6ff
        };
      }
    }
  }
} catch (_) {}

let client = null;
let broadcastCallback = null;

function initDiscordBot(onBroadcast) {
  broadcastCallback = onBroadcast;

  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Channel, Partials.Message]
  });

  client.once('clientReady', async () => {
    console.log(`🤖 [Discord Bot] Connesso con successo come ${client.user.tag}`);
    console.log(`📡 [Discord Bot] Monitoraggio canali e invio risposte finali attivo.`);
    if (pendingAnnouncements.length > 0) {
      const queued = pendingAnnouncements.splice(0, pendingAnnouncements.length);
      for (const item of queued) {
        await sendDiscordAnnouncement(item.text, item.color);
      }
    }
  });

  // Ricezione comandi dai canali Discord per inviarli ad Antigravity
  client.on('messageCreate', async message => {
    if (message.author.bot) return;

    const channelName = message.channel.name ? message.channel.name.toLowerCase() : '';
    let target = null;

    if (channelName.includes('alberto') || channelName.includes('ceo')) {
      target = SUBAGENT_CHANNELS['alberto-ceo'];
    } else if (channelName.includes('luigi') || channelName.includes('backend')) {
      target = SUBAGENT_CHANNELS['luigi-backend'];
    } else if (channelName.includes('gabri') || channelName.includes('frontend')) {
      target = SUBAGENT_CHANNELS['gabri-frontend'];
    } else if (channelName.includes('carlo') || channelName.includes('qa') || channelName.includes('security')) {
      target = SUBAGENT_CHANNELS['carlo-qa'];
    }

    const content = message.content.trim();
    if (content.toLowerCase().startsWith('!project') || content.toLowerCase().startsWith('!workspace') || content.toLowerCase().startsWith('!progetto')) {
      const arg = content.replace(/^!(project|workspace|progetto)\s*/i, '').trim();
      if (!arg || arg.toLowerCase() === 'list') {
        const cur = routing.getTargetProject();
        const list = typeof routing.getProjectsList === 'function' ? routing.getProjectsList() : [];
        let listStr = list.map(p => (p.isActive ? '👉 **[ATTIVO]** ' : '• ') + '**' + p.name + '**: `' + p.path + '`').join('\n');
        await message.channel.send('🏢 **Progetti Software House Registrati:**\n' + (listStr || 'Nessuno') + '\n\n💡 *Usa `!project <nome o percorso>` oppure `!project add <nome> <percorso>`*').catch(() => {});
        return;
      }
      if (arg.toLowerCase().startsWith('add ')) {
        const parts = arg.slice(4).trim().split(/\s+/);
        const name = parts[0];
        const pPath = parts.slice(1).join(' ');
        if (!name || !pPath) {
          await message.channel.send('⚠️ Sintassi corretta: `!project add <NomeProgetto> <PercorsoAssoluto>`').catch(() => {});
          return;
        }
        const res = routing.addProjectToRegistry(name, pPath);
        if (!res.ok) {
          await message.channel.send('❌ **Errore aggiunta progetto:** ' + res.error).catch(() => {});
          return;
        }
        await message.channel.send('🎉 **Progetto "' + name + '" aggiunto e attivato!**\n📂 Percorso: `' + res.projectPath + '`').catch(() => {});
        if (broadcastCallback) {
          broadcastCallback({ type: 'targetProjectChanged', projectPath: res.projectPath, projectName: res.projectName, projects: routing.getProjectsList(), source: 'Discord (' + message.author.username + ')' });
        }
        return;
      }
      const res = typeof routing.selectProjectByNameOrPath === 'function' ? routing.selectProjectByNameOrPath(arg) : routing.setTargetProject(arg);
      if (!res.ok) {
        await message.channel.send('❌ **Errore cambio progetto:** ' + res.error).catch(() => {});
        return;
      }
      await message.channel.send('✅ **Progetto Target aggiornato!**\n📂 Ora il team lavora su: `' + res.projectPath + '`').catch(() => {});
      if (broadcastCallback) {
        broadcastCallback({ type: 'targetProjectChanged', projectPath: res.projectPath, projectName: res.projectName, projects: typeof routing.getProjectsList === 'function' ? routing.getProjectsList() : [], source: 'Discord (' + message.author.username + ')' });
      }
      return;
    }

    if (content.startsWith('!')) {
      const parts = content.slice(1).split(' ');
      const prefix = parts[0].toLowerCase();
      if (SUBAGENT_CHANNELS[prefix] || SUBAGENT_CHANNELS[`${prefix}-ceo`] || SUBAGENT_CHANNELS[`${prefix}-backend`]) {
        target = SUBAGENT_CHANNELS[prefix] || SUBAGENT_CHANNELS[`${prefix}-ceo`] || SUBAGENT_CHANNELS[`${prefix}-backend`];
      }
    }

    if (!target) return;

    // Tutti a riposo: mette il task in coda per eseguirlo automaticamente al risveglio
    if (routing.isResting()) {
      const qPos = routing.enqueueRestTask({ agentId: target.id, text: content, source: `Discord (${message.author.username})` });
      message.channel.send(`💤 ${routing.restMessage()}\n📥 **Task messo in coda (#${qPos})**: verrà inviato automaticamente a **${target.name}** appena la quota si ricarica!`).catch(() => {});
      return;
    }

    // Notifica di presa in carico con reazione
    try {
      await message.react('⚡');
    } catch {}

    const activeProj = routing.getTargetProject();
    const msgContent = `[Progetto Target Attivo: ${activeProj}] Messaggio operativo ricevuto da Discord (${message.author.username}): ${content}`;

    getActiveDaemonConfig().then(daemonCfg => {
      const childEnv = Object.assign({}, process.env);
      if (daemonCfg && daemonCfg.httpPort) {
        childEnv.ANTIGRAVITY_LS_ADDRESS = `127.0.0.1:${daemonCfg.httpPort}`;
      }
      if (daemonCfg && daemonCfg.csrfToken) {
        childEnv.ANTIGRAVITY_CSRF_TOKEN = daemonCfg.csrfToken;
      }

      execFile(resolveLanguageServer(), ['agentapi', 'send-message', routing.resolveSubagent(target.id), msgContent], { timeout: 15000, windowsHide: true, env: childEnv }, (err, stdout, stderr) => {
        if (err) {
          message.channel.send(`❌ Errore recapito a ${target.name}: ${err.message}`).catch(() => {});
        } else {
          try {
            message.react('✅');
          } catch {}

          if (broadcastCallback) {
            broadcastCallback({
              type: 'agentActivity',
              id: target.id,
              agentId: target.id,
              tool: 'Discord Inbound',
              status: `Task da Discord: ${content.slice(0, 50)}`,
              log: `[${new Date().toLocaleTimeString()}] 💬 Ricevuto da Discord (${message.author.username}): "${content}"`
            });
          }
        }
      });
    }).catch(daemonErr => {
      message.channel.send(`❌ Errore interno connessione Antigravity: ${daemonErr.message}`).catch(() => {});
    });
  });

  // Gestione pulsanti interattivi di autorizzazione permessi su Discord
  client.on('interactionCreate', async interaction => {
    if (!interaction.isButton()) return;

    const [action, requestId, agentIdStr] = interaction.customId.split('_');
    const agentId = Number(agentIdStr) || 10;
    const isApproved = action === 'approve';

    await interaction.deferUpdate();

    if (broadcastCallback) {
      broadcastCallback({
        type: 'permissionResponseFromDiscord',
        agentId: agentId,
        requestId: requestId,
        approved: isApproved
      });
    }

    const embed = new EmbedBuilder()
      .setTitle(`🛡️ Permesso Risolto da Discord`)
      .setDescription(`Esito: **${isApproved ? '✅ AUTORIZZATO' : '❌ RIFIUTATO'}** dall'Entità Suprema su Discord.`)
      .setColor(isApproved ? 0x2ea043 : 0xda3633)
      .setTimestamp();

    await interaction.editReply({ embeds: [embed], components: [] });
  });

  client.login(BOT_TOKEN).catch(err => {
    console.error('❌ [Discord Bot] Errore login:', err.message);
  });
}

// Invia SOLO LA RISPOSTA FINALE nel canale specifico dell'agente (zero spam di editing o tool)
const recentSentResponses = new Map(); // deduplica messaggi identici inviati a Discord entro 10 secondi

function sendFinalAgentResponse(agentId, text) {
  if (!client || !client.isReady() || !text || !text.trim()) return;

  const agentEntry = Object.values(SUBAGENT_CHANNELS).find(a => a.id === Number(agentId));
  if (!agentEntry) return;

  // Pulisce markdown o link superflui
  const cleanText = text.trim();
  if (cleanText.length === 0) return;

  const dedupKey = `${agentId}:${cleanText.slice(0, 100)}`;
  const lastSentTime = recentSentResponses.get(dedupKey) || 0;
  if (Date.now() - lastSentTime < 10000) {
    return; // Evita duplicazione
  }
  recentSentResponses.set(dedupKey, Date.now());

  const embed = new EmbedBuilder()
    .setTitle(`💬 Risposta di ${agentEntry.name}`)
    .setDescription(cleanText.slice(0, 3950))
    .setColor(agentEntry.color)
    .setFooter({ text: 'AziendaAI • Lavoro completato' })
    .setTimestamp();

  client.guilds.cache.forEach(guild => {
    // Trova ESATTAMENTE il canale testuale dedicato all'agente (senza inviare a canali duplicati o non pertinenti)
    const channel = guild.channels.cache.find(c => c.isTextBased() && c.name.toLowerCase().includes(agentEntry.channelKeyword.toLowerCase()));
    if (channel) {
      channel.send({ embeds: [embed] }).catch(err => {
        console.warn(`[Discord Bot] Errore invio risposta su #${channel.name}:`, err.message);
      });
    }
  });
}

// Invia richiesta di autorizzazione interattiva con pulsanti su Discord (SOLO nel canale dell'agente o altrimenti solo in sala-operativa)
function sendDiscordPermissionPrompt(requestId, agentId, agentName, tool, command, desc) {
  if (!client || !client.isReady()) return;

  const agentEntry = Object.values(SUBAGENT_CHANNELS).find(a => a.id === Number(agentId));
  const keyword = agentEntry ? agentEntry.channelKeyword : 'sala-operativa';

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`approve_${requestId}_${agentId}`)
      .setLabel('✅ Autorizza')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`reject_${requestId}_${agentId}`)
      .setLabel('❌ Rifiuta')
      .setStyle(ButtonStyle.Danger)
  );

  const embed = new EmbedBuilder()
    .setTitle(`⚠️ RICHIESTA AUTORIZZAZIONE: ${agentName}`)
    .setDescription(`**Tool:** \`${tool}\`\n**Comando:** \`\`\`bash\n${command}\n\`\`\`\n*${desc}*`)
    .setColor(0xd29922)
    .setFooter({ text: 'Puoi autorizzare o rifiutare direttamente premendo uno dei pulsanti sottostanti' })
    .setTimestamp();

  // Invia ESCLUSIVAMENTE a UN SOLO canale di pertinenza (canale dell'agente, oppure sala-operativa se non trovato)
  client.guilds.cache.forEach(guild => {
    let targetChannel = guild.channels.cache.find(c => c.isTextBased() && c.name.includes(keyword));
    if (!targetChannel) {
      targetChannel = guild.channels.cache.find(c => c.isTextBased() && c.name.includes('sala-operativa'));
    }

    if (targetChannel) {
      targetChannel.send({ embeds: [embed], components: [row] }).catch(err => {
        console.warn(`[Discord Bot] Impossibile inviare prompt su #${targetChannel.name}:`, err.message);
      });
    }
  });
}

// Aggiorna la dashboard live delle quote nel canale #📊-monitor-usage
let lastUsageMessageId = null;

async function updateDiscordUsageMonitor(quotaData) {
  if (!client || !client.isReady() || !quotaData) return;

  const geminiWeekly = quotaData.gemini?.weekly ?? 'N/A';
  const gemini5h = quotaData.gemini?.fiveHour ?? 'N/A';
  const claudeWeekly = quotaData.claude?.weekly ?? '100%';
  const claude5h = quotaData.claude?.fiveHour ?? '100%';

  const embed = new EmbedBuilder()
    .setTitle('📊 Monitoraggio Quote & Modelli Antigravity (Live)')
    .setDescription('Stato delle quote e allocazione modelli in tempo reale rilevati direttamente dal Language Server di Antigravity.')
    .setColor(0x58a6ff)
    .addFields(
      {
        name: '🤖 Gemini Models (Flash / Pro)',
        value: `• **Finestra 5 Ore:** \`${gemini5h}\` rimanente (reset: ${quotaData.gemini?.reset5h || 'N/A'})\n• **Finestra Settimanale:** \`${geminiWeekly}\` rimanente (reset: ${quotaData.gemini?.resetWeekly || 'N/A'})`,
        inline: false
      },
      {
        name: '🧠 Claude & GPT Models (Fallback)',
        value: `• **Finestra 5 Ore:** \`${claude5h}\` rimanente (reset: ${quotaData.claude?.reset5h || 'N/A'})\n• **Finestra Settimanale:** \`${claudeWeekly}\` rimanente (reset: ${quotaData.claude?.resetWeekly || 'N/A'})\n• Stato: ${quotaData.resting ? '💤 **TUTTI A RIPOSO**' : (quotaData.claude?.isFallbackActive ? '⚡ **ATTIVO COME FALLBACK**' : '🟢 Pronto per fallback')}`,
        inline: false
      },
      {
        name: '👥 Modelli Subagenti Attivi',
        value: (quotaData.subagents || [
          { name: 'Alberto (CEO)', model: 'Gemini 3.8 Flash (Low)' },
          { name: 'Luigi (Backend)', model: 'Gemini 3.8 Flash (Tiered)' },
          { name: 'Gabri (Frontend)', model: 'Gemini 3.8 Flash (Tiered)' },
          { name: 'Carlo (QA & Revisor)', model: 'Gemini 3.8 Flash (Tiered)' }
        ]).map(a => `• **${a.name}:** \`${a.model}\``).join('\n'),
        inline: false
      }
    )
    .setFooter({ text: 'AziendaAI Telemetry • Aggiornato in tempo reale' })
    .setTimestamp();

  for (const guild of client.guilds.cache.values()) {
    const channel = guild.channels.cache.find(c => c.isTextBased() && (c.name.includes('monitor-usage') || c.name.includes('usage')));
    if (!channel) continue;

    try {
      if (lastUsageMessageId) {
        const msg = await channel.messages.fetch(lastUsageMessageId).catch(() => null);
        if (msg) {
          await msg.edit({ embeds: [embed] });
          continue;
        }
      }
      const newMsg = await channel.send({ embeds: [embed] });
      lastUsageMessageId = newMsg.id;
    } catch (e) {
      console.warn('[Discord Bot] Errore aggiornamento #monitor-usage:', e.message);
    }
  }
}

// Annuncio di transizione di stato in #sala-operativa (con coda se il client non è ancora pronto e deduplica su disco per non ripetere mai lo stesso stato ai riavvii)
const pendingAnnouncements = [];
const LAST_MODE_FILE = path.join(__dirname, '.last_announced_mode');

function getLastAnnouncedMode() {
  try {
    if (fs.existsSync(LAST_MODE_FILE)) {
      return fs.readFileSync(LAST_MODE_FILE, 'utf8').trim();
    }
  } catch {}
  return '';
}

function setLastAnnouncedMode(modeKey) {
  try {
    if (modeKey) fs.writeFileSync(LAST_MODE_FILE, String(modeKey).trim(), 'utf8');
  } catch {}
}

async function sendDiscordAnnouncement(text, color, modeKey = null) {
  if (modeKey) {
    const lastKey = getLastAnnouncedMode();
    if (lastKey === modeKey) return; // Già annunciato questo stato, non inviare duplicati!
    setLastAnnouncedMode(modeKey);
  }
  if (!client || !client.isReady()) {
    pendingAnnouncements.push({ text, color });
    return;
  }
  const embed = new EmbedBuilder().setTitle('🔄 Stato Operativo Squadra & Quote').setDescription(text).setColor(color || 0x58a6ff).setTimestamp();
  for (const guild of client.guilds.cache.values()) {
    const channel = guild.channels.cache.find(c => c.isTextBased() && c.name.includes('sala-operativa'));
    if (channel) await channel.send({ embeds: [embed] }).catch(e => console.warn('[Discord Bot] Annuncio fallito:', e.message));
  }
}

module.exports = {
  sendDiscordAnnouncement,
  initDiscordBot,
  sendFinalAgentResponse,
  sendDiscordPermissionPrompt,
  updateDiscordUsageMonitor,
  getClient: () => client
};
