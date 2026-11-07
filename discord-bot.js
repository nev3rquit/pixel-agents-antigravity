const { Client, GatewayIntentBits, Partials, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const routing = require('./routing');

const CONFIG_PATH = path.join(__dirname, 'discord.config.json');
let BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || '';
try {
  if (fs.existsSync(CONFIG_PATH)) {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (cfg.botToken) BOT_TOKEN = cfg.botToken;
  }
} catch (_) {}
const SERVER_EXE = path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'antigravity', 'resources', 'bin', 'language_server.exe');

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
    } else if (channelName.includes('sala-operativa') || channelName.includes('generale')) {
      target = SUBAGENT_CHANNELS['alberto-ceo'];
    }

    const content = message.content.trim();
    if (content.toLowerCase().startsWith('!project') || content.toLowerCase().startsWith('!workspace') || content.toLowerCase().startsWith('!progetto')) {
      const arg = content.replace(/^!(project|workspace|progetto)\s*/i, '').trim();
      if (!arg) {
        const cur = routing.getTargetProject();
        await message.channel.send(`📂 **Progetto Target Attivo:** \`${cur}\`\n💡 *Usa \`!project <percorso>\` per cambiare il repository/progetto su cui lavorano Alberto, Luigi, Gabri e Carlo.*`).catch(() => {});
        return;
      }
      const res = routing.setTargetProject(arg);
      if (!res.ok) {
        await message.channel.send(`❌ **Errore cambio progetto:** ${res.error}`).catch(() => {});
        return;
      }
      await message.channel.send(`✅ **Progetto Target aggiornato!**\n📂 Ora il team lavora su: \`${res.projectPath}\``).catch(() => {});
      if (broadcastCallback) {
        broadcastCallback({
          type: 'targetProjectChanged',
          projectPath: res.projectPath,
          projectName: res.projectName,
          source: `Discord (${message.author.username})`
        });
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

    execFile(SERVER_EXE, ['agentapi', 'send-message', routing.resolveSubagent(target.id), msgContent], { timeout: 15000, windowsHide: true }, (err, stdout, stderr) => {
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
function sendFinalAgentResponse(agentId, text) {
  if (!client || !client.isReady() || !text || !text.trim()) return;

  const agentEntry = Object.values(SUBAGENT_CHANNELS).find(a => a.id === Number(agentId));
  if (!agentEntry) return;

  // Pulisce markdown o link superflui
  const cleanText = text.trim();
  if (cleanText.length === 0) return;

  const embed = new EmbedBuilder()
    .setTitle(`💬 Risposta di ${agentEntry.name}`)
    .setDescription(cleanText.slice(0, 3950))
    .setColor(agentEntry.color)
    .setFooter({ text: 'AziendaAI • Lavoro completato' })
    .setTimestamp();

  client.guilds.cache.forEach(guild => {
    const channel = guild.channels.cache.find(c => c.isTextBased() && c.name.includes(agentEntry.channelKeyword));
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

// Annuncio di transizione di stato in #sala-operativa (con coda se il client non è ancora pronto)
const pendingAnnouncements = [];
async function sendDiscordAnnouncement(text, color) {
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
