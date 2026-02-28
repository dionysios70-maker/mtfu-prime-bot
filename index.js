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

/* ================= ENV ================= */

const token = process.env.BOT_TOKEN;
const guildId = process.env.GUILD_ID;
const primeRoleId = process.env.PRIME_ROLE_ID;
const staffRoleId = process.env.STAFF_ROLE_ID;
const logChannelId = process.env.LOG_CHANNEL_ID;
const commandChannelId = process.env.COMMAND_CHANNEL_ID;
const backupWebhookUrl = process.env.BACKUP_WEBHOOK_URL;

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
});

/* ================= DATABASE ================= */

const db = new sqlite3.Database("./database.db");

db.run(`
CREATE TABLE IF NOT EXISTS members (
  userId TEXT PRIMARY KEY,
  expiry INTEGER,
  warned INTEGER DEFAULT 0
)
`);

/* ================= BACKUP ================= */

async function sendBackup() {
  if (!backupWebhookUrl) return;

  db.all(`SELECT userId, expiry FROM members`, async (err, rows) => {
    if (err) return console.error(err);

    try {
      await fetch(backupWebhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ members: rows })
      });

      console.log("✅ Backup synced to Google Sheets");
    } catch (err) {
      console.error("Backup failed:", err);
    }
  });
}

/* ================= RESTORE ================= */

async function restoreFromBackup() {
  if (!backupWebhookUrl) return;

  try {
    const response = await fetch(backupWebhookUrl);
    const data = await response.json();

    if (!data.members || !data.members.length) return;

    console.log("🔄 Restoring from Google Sheets...");

    for (const member of data.members) {
      db.run(
        `INSERT OR REPLACE INTO members (userId, expiry, warned)
         VALUES (?, ?, 0)`,
        [member.userId, member.expiry]
      );

      const guild = client.guilds.cache.get(guildId);
      if (!guild) continue;

      const guildMember = await guild.members.fetch(member.userId).catch(() => null);
      if (guildMember)
        await guildMember.roles.add(primeRoleId).catch(() => {});
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
    .setDescription("Manage Prime membership")

    .addSubcommand(sub =>
      sub.setName("add")
        .setDescription("Add months")
        .addUserOption(o => o.setName("user").setDescription("User").setRequired(true))
        .addIntegerOption(o => o.setName("months").setDescription("Months").setRequired(true))
    )

    .addSubcommand(sub =>
      sub.setName("set")
        .setDescription("Set exact remaining days")
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
        .setDescription("Manually trigger backup")
    )

    .addSubcommand(sub =>
      sub.setName("testwarning")
        .setDescription("Send test 3-day warning DM")
        .addUserOption(o => o.setName("user").setDescription("User").setRequired(true))
    )

    .addSubcommand(sub =>
      sub.setName("testexpire")
        .setDescription("Force expire user")
        .addUserOption(o => o.setName("user").setDescription("User").setRequired(true))
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
    return interaction.reply({ content: "❌ Use Prime commands channel.", ephemeral: true });

  await interaction.deferReply();
  const sub = interaction.options.getSubcommand();
  const now = Date.now();

  const user = interaction.options.getUser("user");
  const guildMember = user
    ? await interaction.guild.members.fetch(user.id).catch(() => null)
    : null;

  /* ===== ADD ===== */
  if (sub === "add") {
    const months = interaction.options.getInteger("months");
    const addedTime = months * 30 * 24 * 60 * 60 * 1000;

    db.get(`SELECT * FROM members WHERE userId = ?`, [user.id], async (err, row) => {
      const newExpiry =
        row && row.expiry > now ? row.expiry + addedTime : now + addedTime;

      db.run(
        `INSERT OR REPLACE INTO members (userId, expiry, warned) VALUES (?, ?, 0)`,
        [user.id, newExpiry]
      );

      await guildMember.roles.add(primeRoleId);
      await interaction.editReply(`✅ ${guildMember.displayName} updated.`);
      await sendBackup();
    });
  }

  /* ===== SET ===== */
  if (sub === "set") {
    const days = interaction.options.getInteger("days");
    const newExpiry = now + days * 24 * 60 * 60 * 1000;

    db.run(
      `INSERT OR REPLACE INTO members (userId, expiry, warned) VALUES (?, ?, 0)`,
      [user.id, newExpiry]
    );

    await guildMember.roles.add(primeRoleId);
    await interaction.editReply(`🔧 ${guildMember.displayName} set to ${days} days.`);
    await sendBackup();
  }

  /* ===== REMOVE ===== */
  if (sub === "remove") {
    db.run(`DELETE FROM members WHERE userId = ?`, [user.id]);
    await guildMember.roles.remove(primeRoleId);
    await interaction.editReply("❌ Prime removed.");
    await sendBackup();
  }

  /* ===== LIST ===== */
  if (sub === "list") {
    db.all(`SELECT * FROM members`, async (err, rows) => {
      if (!rows.length)
        return interaction.editReply("No active members.");

      const list = rows.map(r => {
        const remaining = Math.ceil((r.expiry - now) / (1000 * 60 * 60 * 24));
        return `<@${r.userId}> — ${remaining} days`;
      }).join("\n");

      await interaction.editReply(list);
    });
  }

  /* ===== BACKUP ===== */
  if (sub === "backup") {
    await sendBackup();
    await interaction.editReply("📦 Backup sent.");
  }

  /* ===== TEST WARNING ===== */
  if (sub === "testwarning") {
    await guildMember.send("⚠ **TEST: Prime expires in 3 days.**");
    await interaction.editReply("📩 Test warning sent.");
  }

  /* ===== TEST EXPIRE ===== */
  if (sub === "testexpire") {
    db.run(`DELETE FROM members WHERE userId = ?`, [user.id]);
    await guildMember.roles.remove(primeRoleId);
    await guildMember.send("❌ **TEST: Prime expired.**");
    await interaction.editReply("⚠ User force expired.");
    await sendBackup();
  }
});

/* ================= DAILY CHECK (NOON UTC) ================= */

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
