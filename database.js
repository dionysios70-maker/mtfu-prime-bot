
import mysql from "mysql2/promise";

export let db;

export async function initDB(){

  db = await mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10
  });

  await db.query(`
    CREATE TABLE IF NOT EXISTS members (
      user_id VARCHAR(30) PRIMARY KEY,
      expiry BIGINT NOT NULL,
      warned INT DEFAULT 0
    )
  `);

}
