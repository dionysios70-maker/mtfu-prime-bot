
import { all } from "./database.js";

const backupWebhookUrl = process.env.BACKUP_WEBHOOK_URL;

let queued = false;

export function queueBackup(){

  if(queued) return;
  queued = true;

  setTimeout(async ()=>{

    queued = false;

    const members = await all("SELECT userId, expiry FROM members");
    const allocations = await all("SELECT year, month, amount FROM allocations");

    await fetch(backupWebhookUrl,{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({members,allocations})
    });

    console.log("Backup sent");

  },20000);

}
