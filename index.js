require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');

const TOKEN = process.env.DISCORD_TOKEN;
const PREFIX = '.';

if (!TOKEN) {
  console.error('DISCORD_TOKEN no está configurado en .env');
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

client.once('ready', () => console.log(`Bot listo: ${client.user.tag}`));

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith(PREFIX)) return;

  const parts = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();

  if (cmd === 'ping') {
    try {
      const sent = await message.reply('Calculando ping...');
      const latency = sent.createdTimestamp - message.createdTimestamp;
      await sent.edit(`Pong! Latencia: ${latency}ms (WS: ${Math.round(client.ws.ping)}ms)`);
    } catch (e) {}
  } else if (cmd === 'info') {
    try {
      message.reply(`Bot: ${client.user.tag}\nServidores: ${client.guilds.cache.size}`).catch(() => {});
    } catch (e) {}
  } else if (cmd === 'ayuda' || cmd === 'help') {
    message.reply('Comandos disponibles: .ping .info .ayuda').catch(() => {});
  }
});

client.login(TOKEN).catch(err => {
  console.error('Error iniciando sesión en Discord:', err.message);
  process.exit(1);
});

module.exports = { client };