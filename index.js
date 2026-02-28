import { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes } from 'discord.js';
import sqlite3 from 'sqlite3';
import cron from 'node-cron';

const token = process.env.BOT_TOKEN;
const guildId = process.env.GUILD_ID;
const primeRoleId = process.env.PRIME_ROLE_ID;
const staffRoleId = process.env.STAFF_ROLE_ID;
const logChannelId = process.env.LOG_CHANNEL_ID;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers
  ]
});

const db = new sqlite3.Database('./database.db');

db.run(`
CREATE TABLE IF NOT EXISTS members (
  userId TEXT PRIMARY KEY,
  expiry INTEGER,
  warned INTEGER DEFAULT 0
)
`);

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  const command = new SlashCommandBuilder()
    .setName('prime')
    .setDescription('Manage Prime membership')
    .addSubcommand(sub =>
      sub.setName('add')
        .setDescription('Add months to a member')
        .addUserOption(opt =>
          opt.setName('user').setRequired(true))
        .addIntegerOption(opt =>
          opt.setName('months').setRequired(true)))
    .addSubcommand(sub =>
      sub.setName('remove')
        .setDescription('Remove Prime from member')
        .addUserOption(opt =>
          opt.setName('user').setRequired(true)))
    .addSubcommand(sub =>
      sub.setName('check')
        .setDescription('Check Prime expiry')
        .addUserOption(opt =>
          opt.setName('user').setRequired(true)))
    .addSubcommand(sub =>
      sub.setName('list')
        .setDescription('List all Prime members'));

  const rest = new REST({ version: '10' }).setToken(token);
  await rest.put(
    Routes.applicationGuildCommands(client.user.id, guildId),
    { body: [command.toJSON()] }
  );
});

function isStaff(member) {
  return member.roles.cache.has(staffRoleId);
}

async function logMessage(content) {
  const channel = await client.channels.fetch(logChannelId);
  if (channel) channel.send(content);
}

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const member = interaction.member;

  if (!isStaff(member)) {
    return interaction.reply({ content: "❌ Staff only command.", ephemeral: true });
  }

  const sub = interaction.options.getSubcommand();
  const now = Date.now();

  if (sub === 'add') {
    const user = interaction.options.getUser('user');
    const months = interaction.options.getInteger('months');
    const guildMember = await interaction.guild.members.fetch(user.id);

    const addedTime = months * 30 * 24 * 60 * 60 * 1000;

    db.get(`SELECT * FROM members WHERE userId = ?`, [user.id], async (err, row) => {
      let newExpiry = row && row.expiry > now ? row.expiry + addedTime : now + addedTime;

      db.run(`INSERT OR REPLACE INTO members (userId, expiry, warned) VALUES (?, ?, 0)`,
        [user.id, newExpiry]);

      await guildMember.roles.add(primeRoleId);

      interaction.reply(`✅ ${user} now has Prime until <t:${Math.floor(newExpiry/1000)}:F>`);

      logMessage(`🟢 ${interaction.user.tag} added ${months} month(s) to ${user.tag}`);
    });
  }

  if (sub === 'remove') {
    const user = interaction.options.getUser('user');
    const guildMember = await interaction.guild.members.fetch(user.id);

    db.run(`DELETE FROM members WHERE userId = ?`, [user.id]);
    await guildMember.roles.remove(primeRoleId);

    interaction.reply(`❌ Prime removed from ${user}`);

    logMessage(`🔴 ${interaction.user.tag} removed Prime from ${user.tag}`);
  }

  if (sub === 'check') {
    const user = interaction.options.getUser('user');

    db.get(`SELECT * FROM members WHERE userId = ?`, [user.id], (err, row) => {
      if (!row) return interaction.reply(`❌ ${user} does not have Prime.`);

      interaction.reply(`📅 ${user} expires <t:${Math.floor(row.expiry/1000)}:F>`);
    });
  }

  if (sub === 'list') {
    db.all(`SELECT * FROM members`, (err, rows) => {
      if (!rows.length) return interaction.reply("No active Prime members.");

      const list = rows.map(r => `<@${r.userId}>`).join("\n");
      interaction.reply(`📜 **Active Prime Members:**\n${list}`);
    });
  }
});

cron.schedule('0 0 * * *', async () => {
  const now = Date.now();
  const warningTime = 3 * 24 * 60 * 60 * 1000;

  db.all(`SELECT * FROM members`, async (err, rows) => {
    for (const row of rows) {
      const member = await client.guilds.cache.get(guildId).members.fetch(row.userId).catch(() => null);
      if (!member) continue;

      if (row.expiry <= now) {
        await member.roles.remove(primeRoleId);
        db.run(`DELETE FROM members WHERE userId = ?`, [row.userId]);
        member.send("❌ Your Prime membership has expired.");
        logMessage(`⚠ Prime expired for ${member.user.tag}`);
      }
      else if (row.expiry - now <= warningTime && row.warned === 0) {
        member.send("⚠ Your Prime membership expires in 3 days.");
        db.run(`UPDATE members SET warned = 1 WHERE userId = ?`, [row.userId]);
      }
    }
  });
});

client.login(token);
