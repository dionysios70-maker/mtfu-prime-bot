
import cron from "node-cron";
import { all, run } from "../database.js";
const primeRoleId = process.env.PRIME_ROLE_ID;
const guildId = process.env.GUILD_ID;

export function startExpiryCheck(client){

cron.schedule("0 12 * * *", async ()=>{

  const rows = await all("SELECT * FROM members");
  const now = Date.now();

  const guild = client.guilds.cache.get(guildId);

  for(const r of rows){

    if(r.expiry <= now){

      await run("DELETE FROM members WHERE userId=?",[r.userId]);

      const member = await guild.members.fetch(r.userId).catch(()=>null);

      if(member){
        await member.roles.remove(primeRoleId).catch(()=>{});
      }

    }

  }

});

}
