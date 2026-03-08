
import { all } from "./database.js";

const webhook = process.env.BACKUP_WEBHOOK_URL;

let queued=false;

export function queueBackup(){

  if(queued) return;
  queued=true;

  setTimeout(async ()=>{

    queued=false;

    const members = await all("SELECT userId, expiry FROM members");
    const allocations = await all("SELECT year, month, amount FROM allocations");

    if(!members.length){
      console.log("Backup skipped: no members");
      return;
    }

    await fetch(webhook,{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({
        members,
        allocations
      })
    });

    console.log("Backup sent");

  },20000);

}
