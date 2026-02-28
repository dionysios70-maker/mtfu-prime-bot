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

/* ================= SAFETY ================= */

process.on("unhandledRejection", console.error);
process.on("uncaughtException", console.error);

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

function addMonthsUTC(date, months) {
  const d = new Date(date);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

function getMonthYear(date) {
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1
  };
}

async function logMessage(message) {
  if (!logChannelId) return;
  const channel = await client.channels.fetch(logChannelId).catch(() => null);
  if (!channel) return;
  channel.send(message).catch(() => {});
}

/* ================= GOOGLE SHEETS BACKUP ================= */

async function sendBackup() {
  if (!backupWebhookUrl) return;

  db.all(`SELECT userId, expiry FROM members`, async (err, rows) => {
    if (err) return console.error(err);

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

    try {
      await fetch(backupWebhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ members: enriched })
      });
      console.log("✅ Backup synced");
    } catch (err) {
      console.error("Backup failed:", err);
    }
  });
}

async function restoreFromBackup() {
  if (!backupWebhookUrl) return;

  try {
    const res = await fetch(backupWebhookUrl);
    const data = await res.json();

    if (!data.members || !data.members.length) return;

    console.log("🔄 Restoring from backup...");

    for (const m of data.members) {
      db.run(
        `INSERT OR REPLACE INTO members (userId, expiry, warned)
         VALUES (?, ?, 0)`,
        [m.userId, m.expiry]
      );
    }

    console.log("✅ Restore complete");
  } catch (err) {
    console.error("Restore failed:", err);
  }
}

/* ================= READY ================= */

client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  db.get("SELECT COUNT(*) as count FROM members", async (err, row) => {
    if (row.count === 0) {
      await restoreFromBackup();
    }
  });

  const command = new SlashCommandBuilder()
    .setName("prime")
    .setDescription("Manage Prime")

    .addSubcommand(sub =>
      sub.setName("add")
        .setDescription("Add months")
        .addUserOption(o => o.setName("user").setDescription("User").setRequired(true))
        .addIntegerOption(o => o.setName("months").setDescription("Months").setRequired(true))
    )

    .addSubcommand(sub =>
      sub.setName("set")
        .setDescription("Set days manually")
        .addUserOption(o => o.setName("user").setDescription("User").setRequired(true))
        .addIntegerOption(o => o.setName("days").setDescription("Days").setRequired(true))
    )

    .addSubcommand(sub =>
      sub.setName("remove")
        .setDescription("Remove Prime")
        .addUserOption(o => o.setName("user").setDescription("User").setRequired(true))
    )

    .addSubcommand(sub =>
      sub.setName("list")
        .setDescription("List Prime members")
    )

    .addSubcommand(sub =>
      sub.setName("backup")
        .setDescription("Manual backup")
    )

    .addSubcommand(sub =>
      sub.setName("testwarning")
        .setDescription("Test 3-day DM")
        .addUserOption(o => o.setName("user").setDescription("User").setRequired(true))
    )

    .addSubcommand(sub =>
      sub.setName("testexpire")
        .setDescription("Force expire")
        .addUserOption(o => o.setName("user").setDescription("User").setRequired(true))
    )

    .addSubcommand(sub =>
      sub.setName("revenue")
        .setDescription("Show current + next 2 month allocations")
    );

  const rest = new REST({ version: "10" }).setToken(token);

  await rest.put(
    Routes.applicationGuildCommands(client.user.id, guildId),
    { body: [command.toJSON()] }
  );

  console.log("✅ Slash commands registered");
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

  /* ===== ADD ===== */
  if (sub === "add") {
    const user = interaction.options.getUser("user");
    const months = interaction.options.getInteger("months");
    const guildMember = await interaction.guild.members.fetch(user.id);

    db.get(`SELECT * FROM members WHERE userId = ?`, [user.id], async (err, row) => {
      const baseDate =
        row && row.expiry > now
          ? new Date(row.expiry)
          : new Date(now);

      const newExpiry = addMonthsUTC(baseDate, months);

      db.run(
        `INSERT OR REPLACE INTO members (userId, expiry, warned)
         VALUES (?, ?, 0)`,
        [user.id, newExpiry.getTime()]
      );

      await guildMember.roles.add(primeRoleId);

      // ALLOCATIONS SPLIT
      for (let i = 0; i < months; i++) {
        const allocationDate = addMonthsUTC(baseDate, i);
        const { year, month } = getMonthYear(allocationDate);

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

  /* ===== REVENUE ===== */
  if (sub === "revenue") {
    const today = new Date();
    const monthsToShow = [
      getMonthYear(today),
      getMonthYear(addMonthsUTC(today, 1)),
      getMonthYear(addMonthsUTC(today, 2))
    ];

    const results = [];

    for (const m of monthsToShow) {
      await new Promise(resolve => {
        db.get(
          `SELECT SUM(amount) as total
           FROM allocations
           WHERE year = ? AND month = ?`,
          [m.year, m.month],
          (err, row) => {
            const total = row?.total || 0;
            results.push({
              label: `${m.month}/${m.year}`,
              total
            });
            resolve();
          }
        );
      });
    }

    const formatted = results.map(r => {
      const millions = (r.total / 1000000).toFixed(0);
      return `${r.label} → ${r.total.toLocaleString()} GP (${millions}M)`;
    }).join("\n");

    await interaction.editReply(`📊 Allocation Revenue:\n\n${formatted}`);
  }
});

/* ================= DAILY EXPIRY CHECK ================= */

cron.schedule("0 12 * * *", async () => {
  const now = Date.now();
  const warningTime = 3 * 24 * 60 * 60 * 1000;

  db.all(`SELECT * FROM members`, async (err, rows) => {
    for (const row of rows) {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) continue;

      const member = await guild.members.fetch(row.userId).catch(() => null);
      if (!member) continue;

      if (row.expiry <= now) {
        await member.roles.remove(primeRoleId);
        db.run(`DELETE FROM members WHERE userId = ?`, [row.userId]);
        member.send("❌ **MTFU Prime Expired**");
      }

      else if (row.expiry - now <= warningTime && row.warned === 0) {
        member.send("⚠ **MTFU Prime expires in 3 days**");
        db.run(`UPDATE members SET warned = 1 WHERE userId = ?`, [row.userId]);
      }
    }
  });

  await sendBackup();
});

/* ================= EXPRESS ================= */

client.login(token);

const app = express();
app.get("/", (req, res) => res.send("MTFU Prime running."));
const PORT = process.env.PORT || 3000;
app.listen(PORT);
