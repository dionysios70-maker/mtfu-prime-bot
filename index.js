import { initDB } from "./database.js";
import express from "express";
import { Client, GatewayIntentBits, REST, Routes } from "discord.js";

import { registerPrime, primeCommand } from "./commands/prime.js";
import { registerSeason, seasonCommand } from "./commands/season.js";

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
});

const token = process.env.BOT_TOKEN;
console.log("TOKEN:", token);

await initDB();

// ✅ REGISTER FIRST
registerPrime(client);
registerSeason(client);

// ✅ THEN READY EVENT
client.once("ready", async () => {

  const rest = new REST({ version: "10" }).setToken(token);
  
  await rest.put(
    Routes.applicationGuildCommands(client.user.id, process.env.GUILD_ID),
    {
      body: [
        primeCommand.toJSON(),
        seasonCommand.toJSON()
      ]
    }
  );

  console.log(`Logged in as ${client.user.tag}`);




  console.log("Bot ready");

});

client.login(token);

const app = express();
app.get("/", (req,res)=>res.send("Bot running"));
app.listen(process.env.PORT || 3000);
