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

/* ================= ENV VARIABLES ================= */

const token = process.env.BOT_TOKEN;
const guildId = process.env.GUILD_ID;
const primeRoleId = process.env.PRIME_ROLE_ID;
const staffRoleId = process.env.STAFF_ROLE_ID;
const logChannelId = process.env.LOG_CHANNEL_ID;

if (!token) {
  console.error("❌ BOT_TOKEN is missing!");
  process.exit(1);
}

/* ================= DISCORD CLIENT ================= */

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers
  ]
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

/* ================= READY EVENT ================= */

client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  const command = new SlashCommandBuilder()
    .setName("prime")
    .setDescription("Manage Prime membership")
    .addSubcommand(sub =>
      sub.setName("add")
        .setDescription("Add months to a member")
        .addUserOption(opt =>
          opt.setName("user").setDescription("User").setRequired(true))
        .addIntegerOption(opt =>
          opt.setName("months").setDescription("Months").setRequired(true))
    )
    .addSubcommand(sub =>
      sub.setName("remove")
        .setDescription("Remove Prime from member")
        .addUserOption(opt =>
          opt.setName("user").setDescription("User").setRequired(true))
    )
    .addSubcommand(sub =>
      sub.setName("check")
        .setDescription("Check Prime expiry")
        .addUserOption(opt =>
          opt.setName("user").setDescription("User").setRequired(true))
    )
    .addSubcommand(sub =>
      sub.setName("list")
        .setDescription("List all active Prime members")
    );

  const rest = new REST({ version: "10" }).setToken(token);

  await rest.put(
    Routes.applicationGuildCommands(client.user.id, guildId),
    { body: [command.toJSON()] }
  );

  console.log("✅ Slash commands registered");
});

/* ================= UTIL FUNCTIONS ================= */

function isStaff(member) {
  return member.roles.cache.has(staffRoleId);
}

async function logMessage(message) {
  if (!logChannelId) return;
  try {
    const channel = await client.channels.fetch(logChannelId);
    if (channel) channel.send(message);
  } catch (err) {
    console.error("Log error:", err);
  }
}

/* ================= SLASH COMMAND HANDLER ================= */

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const member = interaction.member;

  if (!isStaff(member)) {
    return interaction.reply({
      content: "❌ Staff only command.",
      ephemeral: true
    });
  }

  const sub = interaction.options.getSubcommand();
  const now = Date.now();

  /* ===== ADD ===== */
  if (sub === "add") {
    const user = interaction.options.getUser("user");
    const months = interaction.options.getInteger("months");

    const guildMember = await interaction.guild.members.fetch(user.id);

    const addedTime = months * 30 * 24 * 60 * 60 * 1000;

    db.get(
      `SELECT * FROM members WHERE userId = ?`,
      [user.id],
      async (err, row) => {

        let newExpiry =
          row && row.expiry > now
            ? row.expiry + addedTime
            : now + addedTime;

        db.run(
          `INSERT OR REPLACE INTO members (userId, expiry, warned)
           VALUES (?, ?, 0)`,
          [user.id, newExpiry]
        );

        await guildMember.roles.add(primeRoleId);

        await interaction.reply(
          `✅ ${user} now has Prime until <t:${Math.floor(newExpiry/1000)}:F>`
        );

        logMessage(
          `🟢 ${interaction.user.tag} added ${months} month(s) to ${user.tag}`
        );
      }
    );
  }

  /* ===== REMOVE ===== */
  if (sub === "remove") {
    const user = interaction.options.getUser("user");
    const guildMember = await interaction.guild.members.fetch(user.id);

    db.run(`DELETE FROM members WHERE userId = ?`, [user.id]);
    await guildMember.roles.remove(primeRoleId);

    await interaction.reply(`❌ Prime removed from ${user}`);

    logMessage(
      `🔴 ${interaction.user.tag} removed Prime from ${user.tag}`
    );
  }

  /* ===== CHECK ===== */
  if (sub === "check") {
    const user = interaction.options.getUser("user");

    db.get(
      `SELECT * FROM members WHERE userId = ?`,
      [user.id],
      (err, row) => {
        if (!row) {
          return interaction.reply(
            `❌ ${user} does not have Prime.`
          );
        }

        interaction.reply(
          `📅 ${user} expires <t:${Math.floor(row.expiry/1000)}:F>`
        );
      }
    );
  }

  /* ===== LIST ===== */
  if (sub === "list") {
    db.all(`SELECT * FROM members`, (err, rows) => {
      if (!rows || rows.length === 0) {
        return interaction.reply("No active Prime members.");
      }

      const list = rows.map(r => `<@${r.userId}>`).join("\n");

      interaction.reply(
        `📜 **Active Prime Members:**\n${list}`
      );
    });
  }
});

/* ================= DAILY EXPIRY CHECK ================= */

cron.schedule("0 0 * * *", async () => {
  const now = Date.now();
  const warningTime = 3 * 24 * 60 * 60 * 1000;

  db.all(`SELECT * FROM members`, async (err, rows) => {
    for (const row of rows) {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) continue;

      const member = await guild.members
        .fetch(row.userId)
        .catch(() => null);

      if (!member) continue;

      /* Expired */
      if (row.expiry <= now) {
        await member.roles.remove(primeRoleId);
        db.run(`DELETE FROM members WHERE userId = ?`, [row.userId]);

        member.send("❌ Your Prime membership has expired.");
        logMessage(`⚠ Prime expired for ${member.user.tag}`);
      }

      /* 3 Day Warning */
      else if (row.expiry - now <= warningTime && row.warned === 0) {
        member.send("⚠ Your Prime membership expires in 3 days.");
        db.run(
          `UPDATE members SET warned = 1 WHERE userId = ?`,
          [row.userId]
        );
      }
    }
  });
});

/* ================= LOGIN ================= */

client.login(token);

/* ================= EXPRESS SERVER (RENDER KEEP-ALIVE) ================= */

const app = express();

app.get("/", (req, res) => {
  res.send("MTFU Prime Bot is running.");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🌐 Web server running on port ${PORT}`);
});
