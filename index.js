import express from "express";
import {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  REST,
  Routes
} from "discord.js";
import sqlite3 from "sqlite3";
import cron from "node-cron";

/* ================= CONFIG ================= */

const PRICE_PER_MONTH = 2000000;

const token = process.env.BOT_TOKEN;
const guildId = process.env.GUILD_ID;
const primeRoleId = process.env.PRIME_ROLE_ID;
const staffRoleId = process.env.STAFF_ROLE_ID;
const logChannelId = process.env.LOG_CHANNEL_ID;
const commandChannelId = process.env.COMMAND_CHANNEL_ID;
const backupWebhookUrl = process.env.BACKUP_WEBHOOK_URL;

/* ================= CLIENT ================= */

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
});

/* ================= DATABASE ================= */

const db = new sqlite3.Database("./database.db");

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS members (
      userId TEXT PRIMARY KEY,
      expiry INTEGER,
      warned INTEGER DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS allocations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      year INTEGER,
      month INTEGER,
      amount INTEGER
    )
  `);
});

/* ================= HELPERS ================= */

async function logMessage(message) {
  if (!logChannelId) return;
  const channel = await client.channels.fetch(logChannelId).catch(() => null);
  if (!channel) return;
  channel.send(message).catch(() => {});
}

function getMonthYearFromDate(date) {
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1
  };
}

function addMonthsUTC(date, months) {
  const d = new Date(date);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

/* ================= BACKUP (WITH NICKNAMES) ================= */

async function sendBackup() {
  if (!backupWebhookUrl) return;

  db.all(`SELECT userId, expiry FROM members`, async (err, rows) => {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return;

    const enriched = [];

    for (const row of rows) {
      const member = await guild.members.fetch(row.userId).catch(() => null);

      enriched.push({
        userId: row.userId,
        nickname: member ? member.displayName : "Unknown",
        expiry: row.expiry
      });
    }

    await fetch(backupWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ members: enriched })
    });

    console.log("✅ Backup synced");
  });
}

/* ================= READY ================= */

client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  const command = new SlashCommandBuilder()
    .setName("prime")
    .setDescription("Manage Prime membership")

    .addSubcommand(sub =>
      sub.setName("add")
        .setDescription("Add months")
        .addUserOption(o => o.setName("user").setDescription("User").setRequired(true))
        .addIntegerOption(o => o.setName("months").setDescription("Months").setRequired(true))
    )

    .addSubcommand(sub =>
      sub.setName("revenue")
        .setDescription("Show allocation revenue per month")
    );

  const rest = new REST({ version: "10" }).setToken(token);

  await rest.put(
    Routes.applicationGuildCommands(client.user.id, guildId),
    { body: [command.toJSON()] }
  );

  console.log("✅ Commands registered");
});

/* ================= COMMAND HANDLER ================= */

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (!interaction.member.roles.cache.has(staffRoleId))
    return interaction.reply({ content: "❌ Staff only.", ephemeral: true });

  if (interaction.channelId !== commandChannelId)
    return interaction.reply({ content: "❌ Use Prime channel.", ephemeral: true });

  await interaction.deferReply();

  const sub = interaction.options.getSubcommand();
  const now = Date.now();

  if (sub === "add") {
    const user = interaction.options.getUser("user");
    const months = interaction.options.getInteger("months");
    const guildMember = await interaction.guild.members.fetch(user.id);

    db.get(`SELECT * FROM members WHERE userId = ?`, [user.id], async (err, row) => {
      const baseDate = row && row.expiry > now
        ? new Date(row.expiry)
        : new Date(now);

      const newExpiry = addMonthsUTC(baseDate, months);

      db.run(
        `INSERT OR REPLACE INTO members (userId, expiry, warned)
         VALUES (?, ?, 0)`,
        [user.id, newExpiry.getTime()]
      );

      await guildMember.roles.add(primeRoleId);

      // ALLOCATION SPLIT
      for (let i = 0; i < months; i++) {
        const allocationDate = addMonthsUTC(baseDate, i);
        const { year, month } = getMonthYearFromDate(allocationDate);

        db.run(
          `INSERT INTO allocations (year, month, amount)
           VALUES (?, ?, ?)`,
          [year, month, PRICE_PER_MONTH]
        );
      }

      await interaction.editReply(
        `✅ ${guildMember.displayName} added ${months} month(s)`
      );

      await logMessage(
        `🟢 ${interaction.member.displayName} added ${months} month(s) to ${guildMember.displayName}`
      );

      await sendBackup();
    });
  }

  if (sub === "revenue") {
    db.all(`
      SELECT year, month, SUM(amount) as total
      FROM allocations
      GROUP BY year, month
      ORDER BY year DESC, month DESC
    `, async (err, rows) => {

      if (!rows.length)
        return interaction.editReply("No revenue data.");

      const formatted = rows.map(r => {
        const raw = r.total;
        const formattedM = (raw / 1000000).toFixed(0);
        return `${r.month}/${r.year} → ${raw.toLocaleString()} GP (${formattedM}M)`;
      }).join("\n");

      await interaction.editReply(`📊 Allocation Revenue:\n\n${formatted}`);
    });
  }
});

/* ================= EXPRESS ================= */

client.login(token);

const app = express();
app.get("/", (req, res) => res.send("MTFU Prime running."));
const PORT = process.env.PORT || 3000;
app.listen(PORT);
