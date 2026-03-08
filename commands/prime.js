
import { SlashCommandBuilder, REST, Routes } from "discord.js";
import { run, get, all } from "../database.js";
import { queueBackup } from "../backup.js";

const THIRTY_DAYS = 30*24*60*60*1000;
const primeRoleId = process.env.PRIME_ROLE_ID;
const guildId = process.env.GUILD_ID;
const token = process.env.BOT_TOKEN;

export async function registerPrime(client){

  const command = new SlashCommandBuilder()
    .setName("prime")
    .setDescription("Manage Prime membership")
  
    .addSubcommand(sub =>
      sub
        .setName("add")
        .setDescription("Add Prime membership to a user")
        .addUserOption(option =>
          option
            .setName("user")
            .setDescription("User to add Prime membership to")
            .setRequired(true)
        )
        .addIntegerOption(option =>
          option
            .setName("months")
            .setDescription("Number of months to add")
            .setRequired(true)
        )
    )
  
    .addSubcommand(sub =>
      sub
        .setName("list")
        .setDescription("List all active Prime members")
    )
  
    .addSubcommand(sub =>
      sub
        .setName("backup")
        .setDescription("Force a manual backup to Google Sheets")
    );
  const rest = new REST({version:"10"}).setToken(token);

  await rest.put(
    Routes.applicationGuildCommands(client.user.id,guildId),
    {body:[command.toJSON()]}
  );

  client.on("interactionCreate", async interaction=>{

    if(!interaction.isChatInputCommand()) return;
    if(interaction.commandName !== "prime") return;

    const sub = interaction.options.getSubcommand();

    await interaction.deferReply();

    if(sub==="add"){

      const user = interaction.options.getUser("user");
      const months = interaction.options.getInteger("months");

      const row = await get("SELECT expiry FROM members WHERE userId=?",[user.id]);

      const now = Date.now();
      const base = row?.expiry && row.expiry > now ? row.expiry : now;

      const newExpiry = base + months*THIRTY_DAYS;

      await run(`
        INSERT INTO members (userId,expiry,warned)
        VALUES (?,?,0)
        ON CONFLICT(userId)
        DO UPDATE SET expiry=excluded.expiry,warned=0
      `,[user.id,newExpiry]);

      const member = await interaction.guild.members.fetch(user.id).catch(()=>null);
      if(member) await member.roles.add(primeRoleId).catch(()=>{});

      await interaction.editReply(
        `${user.username} updated until <t:${Math.floor(newExpiry/1000)}:F>`
      );

      queueBackup();

    }

    if(sub==="list"){

      const rows = await all("SELECT * FROM members");
      const now = Date.now();

      const text = rows.map(r=>{
        const days = Math.ceil((r.expiry-now)/(1000*60*60*24));
        return `<@${r.userId}> — ${days} days`;
      }).join("\n");

      await interaction.editReply(text || "No members");

    }

    if(sub==="backup"){
      queueBackup();
      await interaction.editReply("Backup queued");
    }

  });

}
