
import sqlite3 from "sqlite3";

export const db = new sqlite3.Database("./database.db");

export function run(sql, params=[]){
  return new Promise((resolve,reject)=>{
    db.run(sql,params,function(err){
      if(err) reject(err);
      else resolve(this);
    });
  });
}

export function get(sql, params=[]){
  return new Promise((resolve,reject)=>{
    db.get(sql,params,(err,row)=>{
      if(err) reject(err);
      else resolve(row);
    });
  });
}

export function all(sql, params=[]){
  return new Promise((resolve,reject)=>{
    db.all(sql,params,(err,rows)=>{
      if(err) reject(err);
      else resolve(rows);
    });
  });
}

export async function initDB(){

  await run(`
  CREATE TABLE IF NOT EXISTS members (
    userId TEXT PRIMARY KEY,
    expiry INTEGER,
    warned INTEGER DEFAULT 0
  )`);

  await run(`
  CREATE TABLE IF NOT EXISTS allocations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    year INTEGER,
    month INTEGER,
    amount INTEGER
  )`);

}
