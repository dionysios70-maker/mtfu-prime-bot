import { initDB } from "./database.js";
import express from "express";
import { Client, GatewayIntentBits, REST, Routes } from "discord.js";

import { registerPrime, primeCommand } from "./commands/prime.js";
import { registerSeason, seasonCommand } from "./commands/season.js";

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
});

const token = process.env.BOT_TOKEN;

await initDB();

client.once("ready", async () => {

  const rest = new REST({ version: "10" }).setToken(process.env.BOT_TOKEN);
  
  await rest.put(
    Routes.applicationGuildCommands(client.user.id, process.env.GUILD_ID),
    {
      body: [
        primeCommand.toJSON(),
        seasonCommand.toJSON()
      ]
    }
  );

  await registerPrime(client);
  await registerSeason(client);

  console.log(`Logged in as ${client.user.tag}`);




  console.log("Bot ready");

});

client.login(token);

const app = express();
app.get("/", (req,res)=>res.send("Bot running"));
app.listen(process.env.PORT || 3000);
