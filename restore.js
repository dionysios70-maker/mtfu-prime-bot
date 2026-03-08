
import { run } from "./database.js";

const backupWebhookUrl = process.env.BACKUP_WEBHOOK_URL;

export async function restoreFromBackup(){

  if(!backupWebhookUrl) return;

  const res = await fetch(backupWebhookUrl);
  const data = await res.json();

  if(!data.members?.length){
    console.log("No data to restore");
    return;
  }

  await run("DELETE FROM members");
  await run("DELETE FROM allocations");

  for(const m of data.members){
    await run(
      "INSERT OR REPLACE INTO members (userId,expiry,warned) VALUES (?,?,0)",
      [m.userId,m.expiry]
    );
  }

  for(const a of data.allocations || []){
    await run(
      "INSERT INTO allocations (year,month,amount) VALUES (?,?,?)",
      [a.year,a.month,a.amount]
    );
  }

  console.log("Restore complete");

}
