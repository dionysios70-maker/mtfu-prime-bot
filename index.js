
import express from "express";
import { Client, GatewayIntentBits, REST, Routes } from "discord.js";
import { initDB } from "./database.js";
import { restoreFromBackup } from "./restore.js";
import { queueBackup } from "./backup.js";
import { registerPrime } from "./commands/prime.js";
import { startExpiryCheck } from "./systems/expiryCheck.js";

const token = process.env.BOT_TOKEN;
const guildId = process.env.GUILD_ID;

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
});

await initDB();

client.once("clientReady", async () => {

  console.log(`Logged in as ${client.user.tag}`);

  await restoreFromBackup(client);

  await registerPrime(client);

  startExpiryCheck(client);

  console.log("Bot ready");

});

client.login(token);

const app = express();
app.get("/", (req,res)=>res.send("Bot running"));
app.listen(process.env.PORT || 3000);
