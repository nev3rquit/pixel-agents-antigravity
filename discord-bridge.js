const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'discord.config.json');

let discordConfig = {
  webhookUrl: '',
  enabled: false
};

if (fs.existsSync(CONFIG_PATH)) {
  try {
    discordConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    console.warn('[Discord] Errore lettura config:', err.message);
  }
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(discordConfig, null, 2), 'utf8');
  } catch (err) {
    console.error('[Discord] Errore salvataggio config:', err.message);
  }
}

function setDiscordWebhook(url) {
  discordConfig.webhookUrl = (url || '').trim();
  discordConfig.enabled = Boolean(discordConfig.webhookUrl.startsWith('https://discord.com/api/webhooks/'));
  saveConfig();
  console.log(`[Discord] Webhook configurato: ${discordConfig.enabled ? 'ATTIVO' : 'DISATTIVATO'}`);
  return discordConfig.enabled;
}

function sendDiscordNotification(agentName, text, color = 0x58a6ff) {
  if (!discordConfig.enabled || !discordConfig.webhookUrl) return;

  try {
    const payload = JSON.stringify({
      username: `AziendaAI - ${agentName}`,
      avatar_url: 'https://raw.githubusercontent.com/nev3rquit/AziendaAI/main/public/favicon.ico',
      embeds: [
        {
          title: `💼 Notifica Operativa: ${agentName}`,
          description: text.slice(0, 2000),
          color: color,
          timestamp: new Date().toISOString(),
          footer: {
            text: 'AziendaAI Office • Sala Operativa'
          }
        }
      ]
    });

    const parsedUrl = new URL(discordConfig.webhookUrl);
    const req = https.request({
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, res => {
      // silenzioso o log su errore
      if (res.statusCode >= 400) {
        console.warn('[Discord] Webhook response status:', res.statusCode);
      }
    });

    req.on('error', err => {
      console.warn('[Discord] Errore invio webhook:', err.message);
    });

    req.write(payload);
    req.end();
  } catch (err) {
    console.warn('[Discord] Errore payload webhook:', err.message);
  }
}

module.exports = {
  setDiscordWebhook,
  sendDiscordNotification,
  getDiscordConfig: () => discordConfig
};
