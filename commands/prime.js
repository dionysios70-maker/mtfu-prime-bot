import { SlashCommandBuilder } from "discord.js";
import { db } from "../database.js";

const roleId = process.env.PRIME_ROLE_ID;

const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

const command = new SlashCommandBuilder()
  .setName("prime")
  .setDescription("Prime membership commands")

  .addSubcommand(sub =>
    sub.setName("add")
      .setDescription("Add Prime membership")
      .addUserOption(o =>
        o.setName("user")
          .setDescription("User")
          .setRequired(true))
      .addIntegerOption(o =>
        o.setName("months")
          .setDescription("Months")
          .setRequired(true))
  )

  .addSubcommand(sub =>
    sub.setName("list")
      .setDescription("List prime members")
  );

export const primeCommand = command;

export function registerPrime(client) {

  client.on("interactionCreate", async interaction => {

    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== "prime") return;

    const sub = interaction.options.getSubcommand();

    await interaction.deferReply();

    /* ================= ADD ================= */

    if (sub === "add") {
      try {

        const user = interaction.options.getUser("user");
        const months = interaction.options.getInteger("months");

        if (!months || months <= 0 || months > 24) {
          return interaction.editReply("❌ Invalid months (1–24 only)");
        }

        const result = await db.query(
          "SELECT expiry FROM members WHERE user_id = $1",
          [user.id]
        );

        const rows = result.rows;

        const now = Date.now();
        const base = rows.length && rows[0].expiry > now ? rows[0].expiry : now;

        const expiry = base + (months * THIRTY_DAYS);

        if (!expiry || isNaN(expiry)) {
          return interaction.editReply("❌ Failed to calculate expiry");
        }

        await db.query(`
          INSERT INTO members (user_id, expiry, warned)
          VALUES ($1, $2, 0)
          ON CONFLICT (user_id)
          DO UPDATE SET expiry = EXCLUDED.expiry
        `, [user.id, expiry]);

        const member = await interaction.guild.members.fetch(user.id).catch(() => null);
        if (member) await member.roles.add(roleId).catch(() => {});

        await interaction.editReply(
          `✅ ${user.username} updated until <t:${Math.floor(expiry / 1000)}:F>`
        );

      } catch (err) {
        console.error(err);
        await interaction.editReply("❌ Something went wrong");
      }
    }

    /* ================= LIST ================= */

    if (sub === "list") {
      try {

        const result = await db.query("SELECT * FROM members");
        const rows = result.rows;

        const now = Date.now();

        if (!rows.length) {
          return interaction.editReply("No members");
        }

        const text = rows.map(r => {
          const days = Math.ceil((r.expiry - now) / (1000 * 60 * 60 * 24));
          return `<@${r.user_id}> — ${days} days`;
        }).join("\n");

        await interaction.editReply(text);

      } catch (err) {
        console.error(err);
        await interaction.editReply("❌ Failed to fetch members");
      }
    }

  });

}
