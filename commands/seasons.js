import { SlashCommandBuilder, REST, Routes } from "discord.js";
import { db } from "../database.js";

const token = process.env.BOT_TOKEN;
const guildId = process.env.GUILD_ID;

export async function registerSeason(client){

const command = new SlashCommandBuilder()
.setName("season")
.setDescription("Season management")

.addSubcommand(sub =>
  sub.setName("create")
  .setDescription("Create a new season")
  .addStringOption(o =>
    o.setName("name")
    .setDescription("Season name")
    .setRequired(true))
)

.addSubcommand(sub =>
  sub.setName("activate")
  .setDescription("Activate a season")
  .addStringOption(o =>
    o.setName("name")
    .setDescription("Season name")
    .setRequired(true))
)

.addSubcommand(sub =>
  sub.setName("list")
  .setDescription("List all seasons")
);

const rest = new REST({ version: "10" }).setToken(token);

await rest.put(
  Routes.applicationGuildCommands(client.user.id, guildId),
  { body: [command.toJSON()] }
);

client.on("interactionCreate", async interaction => {

if (!interaction.isChatInputCommand()) return;
if (interaction.commandName !== "season") return;

await interaction.deferReply();

const sub = interaction.options.getSubcommand();


// ================= CREATE =================

if (sub === "create") {

const name = interaction.options.getString("name");

await db.query(
  `INSERT INTO seasons (name, created_at, is_active)
   VALUES ($1, $2, false)`,
  [name, Date.now()]
);

await interaction.editReply(`✅ Season **${name}** created`);

}


// ================= ACTIVATE =================

if (sub === "activate") {

const name = interaction.options.getString("name");

// deactivate all
await db.query(`UPDATE seasons SET is_active = false`);

// activate selected
const result = await db.query(
  `UPDATE seasons
   SET is_active = true
   WHERE name = $1
   RETURNING *`,
  [name]
);

if (result.rowCount === 0) {
  return interaction.editReply("❌ Season not found");
}

await interaction.editReply(`🔥 Season **${name}** is now active`);

}


// ================= LIST =================

if (sub === "list") {

const result = await db.query(
  `SELECT * FROM seasons ORDER BY id ASC`
);

const rows = result.rows;

if (!rows.length) {
  return interaction.editReply("No seasons found");
}

const text = rows.map(s => {
  return `${s.is_active ? "🔥" : "•"} ${s.name}`;
}).join("\n");

await interaction.editReply(text);

}

});

}
