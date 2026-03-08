
import express from "express";
import { Client, GatewayIntentBits } from "discord.js";
import { initDB } from "./database.js";
import { restoreFromBackup } from "./restore.js";
import { registerPrime } from "./commands/prime.js";
import { startExpiryCheck } from "./systems/expiryCheck.js";

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
});

const token = process.env.BOT_TOKEN;

await initDB();

client.once("clientReady", async () => {

  console.log(`Logged in as ${client.user.tag}`);

  await restoreFromBackup();

  await registerPrime(client);

  startExpiryCheck(client);

  console.log("Bot ready");

});

client.login(token);

const app = express();
app.get("/", (req,res)=>res.send("Bot running"));
app.listen(process.env.PORT || 3000);
