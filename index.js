import { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes } from 'discord.js';
import sqlite3 from 'sqlite3';
import cron from 'node-cron';

const token = process.env.BOT_TOKEN;
const guildId = process.env.GUILD_ID;
const primeRoleId = process.env.PRIME_ROLE_ID;

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
          opt.setName('user')
            .setDescription('User')
            .setRequired(true))
        .addIntegerOption(opt =>
          opt.setName('months')
            .setDescription('Months to add')
            .setRequired(true))
    );

  const rest = new REST({ version: '10' }).setToken(token);
  await rest.put(
    Routes.applicationGuildCommands(client.user.id, guildId),
    { body: [command.toJSON()] }
  );
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'prime') {
    const user = interaction.options.getUser('user');
    const months = interaction.options.getInteger('months');
    const member = await interaction.guild.members.fetch(user.id);

    const now = Date.now();
    const addedTime = months * 30 * 24 * 60 * 60 * 1000;

    db.get(`SELECT * FROM members WHERE userId = ?`, [user.id], (err, row) => {
      let newExpiry;

      if (row && row.expiry > now) {
        newExpiry = row.expiry + addedTime;
      } else {
        newExpiry = now + addedTime;
      }

      db.run(
        `INSERT OR REPLACE INTO members (userId, expiry, warned)
         VALUES (?, ?, 0)`,
        [user.id, newExpiry]
      );

      member.roles.add(primeRoleId);

      interaction.reply(
        `✅ ${user} now has Prime until <t:${Math.floor(newExpiry/1000)}:F>`
      );
    });
  }
});

cron.schedule('0 0 * * *', async () => {
  const now = Date.now();
  const warningTime = 3 * 24 * 60 * 60 * 1000;

  db.all(`SELECT * FROM members`, async (err, rows) => {
    for (const row of rows) {
      const member = await client.guilds.cache
        .get(guildId)
        .members.fetch(row.userId)
        .catch(() => null);

      if (!member) continue;

      if (row.expiry <= now) {
        await member.roles.remove(primeRoleId);
        db.run(`DELETE FROM members WHERE userId = ?`, [row.userId]);
        member.send("❌ Your Prime membership has expired.");
      } 
      else if (row.expiry - now <= warningTime && row.warned === 0) {
        member.send("⚠ Your Prime membership expires in 3 days.");
        db.run(`UPDATE members SET warned = 1 WHERE userId = ?`, [row.userId]);
      }
    }
  });
});

client.login(token);
