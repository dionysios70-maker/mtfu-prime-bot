
import { run } from "./database.js";

const webhook = process.env.BACKUP_WEBHOOK_URL;

export async function restoreFromBackup(){

  if(!webhook) return;

  const res = await fetch(webhook);
  const data = await res.json();

  if(!data.members || !data.members.length){
    console.log("Restore skipped: sheet empty");
    return;
  }

  await run("DELETE FROM members");
  await run("DELETE FROM allocations");

  for(const m of data.members){

    const expiry = Number(m.expiry);

    if(!expiry || expiry < 1000000000000){
      console.log("Invalid expiry skipped:", m);
      continue;
    }

    await run(
      "INSERT OR REPLACE INTO members (userId, expiry, warned) VALUES (?,?,0)",
      [String(m.userId), expiry]
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
