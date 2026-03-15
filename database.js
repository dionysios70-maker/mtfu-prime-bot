import pkg from "pg";
const { Pool } = pkg;

export const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

export async function initDB(){

  await db.query(`
    CREATE TABLE IF NOT EXISTS members (
      user_id TEXT PRIMARY KEY,
      expiry BIGINT NOT NULL,
      warned INT DEFAULT 0
    )
  `);

}
