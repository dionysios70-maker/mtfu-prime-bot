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
        .setDescription("Add months")
        .addUserOption(o =>
          o.setName("user")
            .setDescription("User to give Prime to")
            .setRequired(true))
        .addIntegerOption(o =>
          o.setName("months")
            .setDescription("Months to add")
            .setRequired(true))
    )

    .addSubcommand(sub =>
      sub.setName("remove")
        .setDescription("Remove Prime")
        .addUserOption(o =>
          o.setName("user")
            .setDescription("User to remove Prime from")
            .setRequired(true))
    )

    .addSubcommand(sub =>
      sub.setName("list")
        .setDescription("List Prime members with remaining time")
    )

    .addSubcommand(sub =>
      sub.setName("testwarning")
        .setDescription("Send 3-day warning DM immediately")
        .addUserOption(o =>
          o.setName("user")
            .setDescription("User to test warning for")
            .setRequired(true))
    )

    .addSubcommand(sub =>
      sub.setName("testexpire")
        .setDescription("Force expire a user immediately")
        .addUserOption(o =>
          o.setName("user")
            .setDescription("User to force expire")
            .setRequired(true))
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

async function logMessage(message) {
  const channel = await client.channels.fetch(logChannelId).catch(() => null);
  if (channel) channel.send(message);
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

  await interaction.deferReply();

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

      await interaction.editReply(`✅ ${guildMember.displayName} now has Prime until <t:${Math.floor(newExpiry/1000)}:F>`);

      logMessage(`🟢 ${interaction.member.displayName} added ${months} month(s) to ${guildMember.displayName}`);
    });
  }

  /* ===== REMOVE ===== */
  if (sub === "remove") {
    const user = interaction.options.getUser("user");
    const guildMember = await interaction.guild.members.fetch(user.id);

    db.run(`DELETE FROM members WHERE userId = ?`, [user.id]);
    await guildMember.roles.remove(primeRoleId);

    await interaction.editReply(`❌ Prime removed from ${guildMember.displayName}`);

    logMessage(`🔴 ${interaction.member.displayName} removed Prime from ${guildMember.displayName}`);
  }

  /* ===== LIST ===== */
  if (sub === "list") {
    db.all(`SELECT * FROM members`, async (err, rows) => {
      if (!rows.length)
        return interaction.editReply("No active Prime members.");

      const list = rows.map(r => {
        const remaining = Math.ceil((r.expiry - now) / (1000 * 60 * 60 * 24));
        return `<@${r.userId}> — ${remaining} days remaining`;
      }).join("\n");

      await interaction.editReply(`📜 **Prime Members:**\n${list}`);
    });
  }

  /* ===== TEST WARNING ===== */
  if (sub === "testwarning") {
    const user = interaction.options.getUser("user");
    const guildMember = await interaction.guild.members.fetch(user.id);

    await guildMember.send(
      "⚠ **MTFU Prime Expiring Soon (TEST)**\n\nYour Prime membership expires in 3 days.\nPlease contact staff if you wish to renew."
    );

    await interaction.editReply("📩 3-day warning test DM sent.");

    logMessage(`🧪 ${interaction.member.displayName} triggered test warning for ${guildMember.displayName}`);
  }

  /* ===== TEST EXPIRE ===== */
  if (sub === "testexpire") {
    const user = interaction.options.getUser("user");
    const guildMember = await interaction.guild.members.fetch(user.id);

    db.run(`DELETE FROM members WHERE userId = ?`, [user.id]);
    await guildMember.roles.remove(primeRoleId);

    await guildMember.send(
      "❌ **MTFU Prime Expired (TEST)**\n\nYour Prime membership has expired.\nContact staff to renew."
    );

    await interaction.editReply("⚠ User force-expired for testing.");

    logMessage(`🧪 ${interaction.member.displayName} force-expired ${guildMember.displayName}`);
  }
});

/* ================= DAILY EXPIRY CHECK (NOON UTC) ================= */

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

        member.send("❌ **MTFU Prime Expired**\n\nYour Prime membership has expired.\nContact staff to renew.");

        logMessage(`⚠ Prime expired for ${member.displayName}`);
      }

      else if (row.expiry - now <= warningTime && row.warned === 0) {
        member.send("⚠ **MTFU Prime Expiring Soon**\n\nYour Prime membership expires in 3 days.\nPlease contact staff if you wish to renew.");

        db.run(`UPDATE members SET warned = 1 WHERE userId = ?`, [row.userId]);
      }
    }
  });
});

/* ================= LOGIN ================= */

client.login(token);

/* ================= EXPRESS SERVER ================= */

const app = express();
app.get("/", (req, res) => res.send("MTFU Prime Bot running."));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Web server running on port ${PORT}`));
