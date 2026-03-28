
import cron from "node-cron";
import { db } from "../database.js";

const guildId = process.env.GUILD_ID;
const roleId = process.env.PRIME_ROLE_ID;

export function startExpiryCheck(client){

cron.schedule("0 12 * * *", async ()=>{

const result = await db.query("SELECT * FROM members");
const rows = result.rows;
const now = Date.now();

const guild = client.guilds.cache.get(guildId);

for(const r of rows){

if(r.expiry <= now){

await db.query(
"DELETE FROM members WHERE user_id=?",
[r.user_id]
);

const member = await guild.members.fetch(r.user_id).catch(()=>null);

if(member){
await member.roles.remove(roleId).catch(()=>{});
}

}

}

});

}
