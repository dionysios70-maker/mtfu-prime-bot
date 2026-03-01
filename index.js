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

const PRICE_PER_MONTH = 2000000;
const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

/* ================= CLIENT ================= */

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
});

/* ================= DATABASE ================= */

const db = new sqlite3.Database("./database.db");

db.serialize(() => {

  /* ===== EXISTING TABLES (UNCHANGED) ===== */

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

  /* ===== NEW TABLES (STEP 1 ADDITION) ===== */

  db.run(`
    CREATE TABLE IF NOT EXISTS seasons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      createdAt INTEGER,
      isActive INTEGER DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      seasonId INTEGER,
      name TEXT,
      createdAt INTEGER
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS points (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId TEXT,
      seasonId INTEGER,
      eventId INTEGER,
      points INTEGER,
      givenBy TEXT,
      timestamp INTEGER
    )
  `);
  

});

/* ================= LOGGING ================= */

async function logMessage(message) {
  if (!logChannelId) return;
  const channel = await client.channels.fetch(logChannelId).catch(() => null);
  if (!channel) return;
  channel.send(message).catch(() => {});
}

/* ================= BACKUP (WITH NICKNAMES) ================= */

async function sendBackup() {
  if (!backupWebhookUrl) return;

  const guild = client.guilds.cache.get(guildId);
  if (!guild) return;

  try {
    const members = await new Promise((resolve, reject) => {
      db.all(`SELECT userId, expiry FROM members`, async (err, rows) => {
        if (err) return reject(err);

        const enriched = [];

        for (const row of rows) {
          const member = await guild.members.fetch(row.userId).catch(() => null);

          enriched.push({
            userId: row.userId,
            nickname: member ? member.displayName : "Unknown",
            expiry: row.expiry
          });
        }

        resolve(enriched);
      });
    });

    const allocations = await new Promise((resolve, reject) => {
      db.all(`SELECT year, month, amount FROM allocations`, (err, rows) => {
        if (err) return reject(err);
        resolve(rows || []);
      });
    });

    const seasons = await new Promise((resolve) => {
      db.all(`SELECT * FROM seasons`, (err, rows) => {
        if (err) return resolve([]);
        resolve(rows || []);
      });
    });

    const events = await new Promise((resolve) => {
      db.all(`SELECT * FROM events`, (err, rows) => {
        if (err) return resolve([]);
        resolve(rows || []);
      });
    });

    const points = await new Promise((resolve) => {
      db.all(`SELECT * FROM points`, (err, rows) => {
        if (err) return resolve([]);
        resolve(rows || []);
      });
    });

    await fetch(backupWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        members,
        allocations,
        seasons,
        events,
        points
      })
    });

    console.log("✅ Full backup synced to Google Sheets");

  } catch (err) {
    console.error("Backup failed:", err);
  }
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
    )

    .addSubcommand(sub =>
      sub.setName("revenue")
        .setDescription("View revenue (default: current + next 2 months)")
        .addStringOption(o =>
          o.setName("month")
            .setDescription("Specific month (YYYY-MM)")
        )
        .addStringOption(o =>
          o.setName("from")
            .setDescription("From month (YYYY-MM)")
        )
        .addStringOption(o =>
          o.setName("to")
            .setDescription("To month (YYYY-MM)")
        )
    );

  const seasonCommand = new SlashCommandBuilder()
    .setName("season")
    .setDescription("Manage seasons")
  
    .addSubcommand(sub =>
      sub.setName("create")
        .setDescription("Create a new season")
        .addStringOption(o =>
          o.setName("name")
           .setDescription("Season name")
           .setRequired(true)
        )
    )
  
    .addSubcommand(sub =>
      sub.setName("end")
        .setDescription("End the active season")
    )
  
    .addSubcommand(sub =>
      sub.setName("list")
        .setDescription("List all seasons")
    );

  const rest = new REST({ version: "10" }).setToken(token);

  await rest.put(
    Routes.applicationGuildCommands(client.user.id, guildId),
    { body: [command.toJSON(), seasonCommand.toJSON()] }
  );

  console.log("✅ Slash commands registered");
});

/* ================= COMMAND HANDLER ================= */

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

// ================= SEASON COMMAND =================
if (interaction.commandName === "season") {

  await interaction.deferReply();  // ALWAYS defer immediately

  if (!interaction.member.roles.cache.has(process.env.SYSTEM_ADMIN_ROLE_ID)) {
    return interaction.editReply("❌ You do not have permission.");
  }

  const sub = interaction.options.getSubcommand();
  const now = Date.now();

  if (sub === "create") {
    const name = interaction.options.getString("name");

    db.get(`SELECT * FROM seasons WHERE isActive = 1`, (err, row) => {
      if (row) {
        return interaction.editReply("❌ There is already an active season.");
      }
      
      db.run(
        `INSERT INTO seasons (name, createdAt, isActive) VALUES (?, ?, 1)`,
        [name, now]
      );
      sendBackup();
      interaction.editReply(`✅ Season "${name}" created and set active.`);
    });
  }

  if (sub === "end") {
    db.get(`SELECT * FROM seasons WHERE isActive = 1`, (err, row) => {
      if (!row) {
        return interaction.editReply("❌ No active season.");
      }

      db.run(`UPDATE seasons SET isActive = 0 WHERE id = ?`, [row.id]);
      sendBackup();
      interaction.editReply(`🏁 Season "${row.name}" ended.`);
    });
  }

  if (sub === "list") {
    db.all(`SELECT * FROM seasons ORDER BY createdAt DESC`, (err, rows) => {
      if (!rows.length) {
        return interaction.editReply("No seasons found.");
      }

      const formatted = rows.map(s =>
        `${s.isActive ? "🟢" : "⚪"} ${s.name}`
      ).join("\n");
  
      interaction.editReply(`📅 Seasons:\n\n${formatted}`);
    });
  }

  return;
}
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
    const addedTime = months * THIRTY_DAYS;

    db.get(`SELECT * FROM members WHERE userId = ?`, [user.id], async (err, row) => {
      const baseExpiry =
        row && row.expiry > now ? row.expiry : now;

      const newExpiry = baseExpiry + addedTime;

      db.run(
        `INSERT OR REPLACE INTO members (userId, expiry, warned) VALUES (?, ?, 0)`,
        [user.id, newExpiry]
      );

      await guildMember.roles.add(primeRoleId);

      // ALLOCATIONS (Calendar Month Based)
      const paymentDate = new Date(); // when payment confirmed

      for (let i = 0; i < months; i++) {
        const allocationDate = new Date(
          Date.UTC(
            paymentDate.getUTCFullYear(),
            paymentDate.getUTCMonth() + i,
            1
          )
        );

        const year = allocationDate.getUTCFullYear();
        const month = allocationDate.getUTCMonth() + 1;

        db.run(
          `INSERT INTO allocations (year, month, amount) VALUES (?, ?, ?)`,
          [year, month, PRICE_PER_MONTH]
        );
      }
          
      
      

      await interaction.editReply(
        `✅ ${guildMember.displayName} updated until <t:${Math.floor(newExpiry/1000)}:F>`
      );

      await logMessage(
        `🟢 ${interaction.member.displayName} added ${months} month(s) to ${guildMember.displayName}`
      );

      await sendBackup();
    });
  }

  /* ===== REVENUE ===== */
  if (sub === "revenue") {

    const monthInput = interaction.options.getString("month");
    const fromInput = interaction.options.getString("from");
    const toInput = interaction.options.getString("to");
  
    let conditions = [];
    let params = [];
  
    /* ================= FILTERED MODES ================= */
  
    if (monthInput) {
      const [year, month] = monthInput.split("-").map(Number);
      conditions.push("year = ? AND month = ?");
      params.push(year, month);
    }
  
    else if (fromInput && toInput) {
      const [fromYear, fromMonth] = fromInput.split("-").map(Number);
      const [toYear, toMonth] = toInput.split("-").map(Number);
  
      conditions.push(
        `(year > ? OR (year = ? AND month >= ?)) AND
         (year < ? OR (year = ? AND month <= ?))`
      );
  
      params.push(
        fromYear, fromYear, fromMonth,
        toYear, toYear, toMonth
      );
    }
  
    /* ================= DEFAULT MODE (B OPTION) ================= */
  
    else {
      const now = new Date();
  
      const monthsToShow = [];
  
      for (let i = 0; i < 3; i++) {
        const d = new Date(Date.UTC(
          now.getUTCFullYear(),
          now.getUTCMonth() + i,
          1
        ));
  
        monthsToShow.push({
          year: d.getUTCFullYear(),
          month: d.getUTCMonth() + 1
        });
      }
  
      const results = [];
  
      for (const m of monthsToShow) {
        await new Promise(resolve => {
          db.get(
            `SELECT SUM(amount) as total FROM allocations WHERE year = ? AND month = ?`,
            [m.year, m.month],
            (err, row) => {
              results.push({
                label: `${m.month}/${m.year}`,
                total: row?.total || 0
              });
              resolve();
            }
          );
        });
      }
  
      const formatted = results.map(r =>
        `${r.label} → ${Number(r.total).toLocaleString()} GP`
      ).join("\n");
  
      return interaction.editReply(`📊 Allocation Revenue:\n\n${formatted}`);
    }
  
    /* ================= FILTERED QUERY ================= */
  
    let query = `SELECT year, month, SUM(amount) as total FROM allocations`;
  
    if (conditions.length)
      query += " WHERE " + conditions.join(" AND ");
  
    query += " GROUP BY year, month ORDER BY year, month";
  
    db.all(query, params, async (err, rows) => {
  
      if (!rows.length)
        return interaction.editReply("No revenue data found.");
  
      const formatted = rows.map(r =>
        `${r.month}/${r.year} → ${Number(r.total).toLocaleString()} GP`
      ).join("\n");
  
      await interaction.editReply(`📊 Allocation Revenue:\n\n${formatted}`);
    });
  }
  
    /* ===== (ALL OTHER ORIGINAL COMMANDS REMAIN UNCHANGED BELOW) ===== */
  
    if (sub === "set") {
      const days = interaction.options.getInteger("days");
      const newExpiry = now + days * 24 * 60 * 60 * 1000;
  
      db.run(
        `INSERT OR REPLACE INTO members (userId, expiry, warned) VALUES (?, ?, 0)`,
        [user.id, newExpiry]
      );

    await guildMember.roles.add(primeRoleId);

    await interaction.editReply(
      `🔧 ${guildMember.displayName} set to ${days} days remaining`
    );

    await logMessage(
      `🛠 ${interaction.member.displayName} set ${guildMember.displayName} to ${days} days`
    );

    await sendBackup();
  }

  if (sub === "remove") {
    db.run(`DELETE FROM members WHERE userId = ?`, [user.id]);
    await guildMember.roles.remove(primeRoleId);

    await interaction.editReply(
      `❌ Prime removed from ${guildMember.displayName}`
    );

    await logMessage(
      `🔴 ${interaction.member.displayName} removed Prime from ${guildMember.displayName}`
    );

    await sendBackup();
  }

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

  if (sub === "backup") {
    await sendBackup();
    await interaction.editReply("📦 Backup sent.");
  }

  if (sub === "testwarning") {
    await guildMember.send("⚠ **TEST: Prime expires in 3 days.**");
    await interaction.editReply("📩 Test warning sent.");
  }

  if (sub === "testexpire") {
    db.run(`DELETE FROM members WHERE userId = ?`, [user.id]);
    await guildMember.roles.remove(primeRoleId);
    await guildMember.send("❌ **TEST: Prime expired.**");
    await interaction.editReply("⚠ User force expired.");
    await sendBackup();
  }
});


/* ================= DAILY CHECK ================= */

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
app.listen(process.env.PORT || 3000);
