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

/* ================= READY ================= */

client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  const command = new SlashCommandBuilder()
    .setName("prime")
    .setDescription("Manage Prime membership")

    .addSubcommand(sub =>
      sub.setName("add")
        .setDescription("Add months to a member")
        .addUserOption(o =>
          o.setName("user")
            .setDescription("User to give Prime to")
            .setRequired(true))
        .addIntegerOption(o =>
          o.setName("months")
            .setDescription("Number of months to add")
            .setRequired(true))
    )

    .addSubcommand(sub =>
      sub.setName("set")
        .setDescription("Set exact remaining days")
        .addUserOption(o =>
          o.setName("user")
            .setDescription("User to modify")
            .setRequired(true))
        .addIntegerOption(o =>
          o.setName("days")
            .setDescription("Exact number of days remaining")
            .setRequired(true))
    )

    .addSubcommand(sub =>
      sub.setName("remove")
        .setDescription("Remove Prime from member")
        .addUserOption(o =>
          o.setName("user")
            .setDescription("User to remove Prime from")
            .setRequired(true))
    )

    .addSubcommand(sub =>
      sub.setName("check")
        .setDescription("Check Prime expiry")
        .addUserOption(o =>
          o.setName("user")
            .setDescription("User to check")
            .setRequired(true))
    )

    .addSubcommand(sub =>
      sub.setName("list")
        .setDescription("List all Prime members with remaining time")
    )

    .addSubcommand(sub =>
      sub.setName("backup")
        .setDescription("Manually trigger Google Sheets backup")
    );

  const rest = new REST({ version: "10" }).setToken(token);

  await rest.put(
    Routes.applicationGuildCommands(client.user.id, guildId),
    { body: [command.toJSON()] }
  );

  console.log("✅ Slash commands registered");
});

/* ================= HELPERS ================= */

function isStaff(member) {
  return member.roles.cache.has(staffRoleId);
}

async function logMessage(msg) {
  if (!logChannelId) return;
  const channel = await client.channels.fetch(logChannelId).catch(() => null);
  if (channel) channel.send(msg);
}

async function sendBackup() {
  if (!backupWebhookUrl) return;

  db.all(`SELECT * FROM members`, async (err, rows) => {
    const payload = { members: rows };

    try {
      await fetch(backupWebhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      console.log("✅ Backup sent to Google Sheets");
    } catch (err) {
      console.error("Backup failed:", err);
    }
  });
}

/* ================= COMMAND HANDLER ================= */

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (!isStaff(interaction.member))
    return interaction.reply({ content: "❌ Staff only.", ephemeral: true });

  if (interaction.channelId !== commandChannelId)
    return interaction.reply({
      content: "❌ Use this command in the Prime commands channel only.",
      ephemeral: true
    });

  const sub = interaction.options.getSubcommand();
  const now = Date.now();

  /* ===== ADD ===== */
  if (sub === "add") {
    const user = interaction.options.getUser("user");
    const months = interaction.options.getInteger("months");
    const guildMember = await interaction.guild.members.fetch(user.id);

    const addedTime = months * 30 * 24 * 60 * 60 * 1000;

    db.get(`SELECT * FROM members WHERE userId = ?`, [user.id], async (err, row) => {
      const newExpiry =
        row && row.expiry > now ? row.expiry + addedTime : now + addedTime;

      db.run(
        `INSERT OR REPLACE INTO members (userId, expiry, warned) VALUES (?, ?, 0)`,
        [user.id, newExpiry]
      );

      await guildMember.roles.add(primeRoleId);

      interaction.reply(`✅ ${user} now has Prime until <t:${Math.floor(newExpiry/1000)}:F>`);

      logMessage(`🟢 ${interaction.user.tag} added ${months} month(s) to ${user.tag}`);
    });
  }

  /* ===== SET ===== */
  if (sub === "set") {
    const user = interaction.options.getUser("user");
    const days = interaction.options.getInteger("days");
    const guildMember = await interaction.guild.members.fetch(user.id);

    const newExpiry = now + (days * 24 * 60 * 60 * 1000);

    db.run(
      `INSERT OR REPLACE INTO members (userId, expiry, warned) VALUES (?, ?, 0)`,
      [user.id, newExpiry]
    );

    await guildMember.roles.add(primeRoleId);

    interaction.reply(`🔧 ${user} set to ${days} days remaining.`);
    logMessage(`🛠 ${interaction.user.tag} set ${user.tag} to ${days} days`);
  }

  /* ===== REMOVE ===== */
  if (sub === "remove") {
    const user = interaction.options.getUser("user");
    const guildMember = await interaction.guild.members.fetch(user.id);

    db.run(`DELETE FROM members WHERE userId = ?`, [user.id]);
    await guildMember.roles.remove(primeRoleId);

    interaction.reply(`❌ Prime removed from ${user}`);
    logMessage(`🔴 ${interaction.user.tag} removed Prime from ${user.tag}`);
  }

  /* ===== CHECK ===== */
  if (sub === "check") {
    const user = interaction.options.getUser("user");

    db.get(`SELECT * FROM members WHERE userId = ?`, [user.id], (err, row) => {
      if (!row)
        return interaction.reply(`❌ ${user} does not have Prime.`);

      const remaining = Math.ceil((row.expiry - now) / (1000 * 60 * 60 * 24));

      interaction.reply(
        `📅 ${user} expires <t:${Math.floor(row.expiry/1000)}:F>\nRemaining: ${remaining} days`
      );
    });
  }

  /* ===== LIST ===== */
  if (sub === "list") {
    db.all(`SELECT * FROM members`, (err, rows) => {
      if (!rows.length)
        return interaction.reply("No active Prime members.");

      const list = rows.map(r => {
        const remaining = Math.ceil((r.expiry - now) / (1000 * 60 * 60 * 24));
        return `<@${r.userId}> — ${remaining} days remaining`;
      }).join("\n");

      interaction.reply(`📜 **Prime Members:**\n${list}`);
    });
  }

  /* ===== BACKUP ===== */
  if (sub === "backup") {
    await sendBackup();
    interaction.reply("📦 Backup sent to Google Sheets.");
  }
});

/* ================= DAILY JOB ================= */

cron.schedule("0 0 * * *", async () => {
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

        member.send(
          "❌ **MTFU Prime Expired**\n\nYour Prime membership has expired.\nContact staff to renew."
        );

        logMessage(`⚠ Prime expired for ${member.user.tag}`);
      }

      else if (row.expiry - now <= warningTime && row.warned === 0) {
        member.send(
          "⚠ **MTFU Prime Expiring Soon**\n\nYour Prime membership expires in 3 days.\nPlease contact staff if you wish to renew."
        );

        db.run(`UPDATE members SET warned = 1 WHERE userId = ?`, [row.userId]);
      }
    }
  });

  await sendBackup();
});

/* ================= LOGIN ================= */

client.login(token);

/* ================= EXPRESS SERVER ================= */

const app = express();

app.get("/", (req, res) => {
  res.send("MTFU Prime Bot running.");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🌐 Web server running on port ${PORT}`);
});
