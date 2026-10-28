import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH || path.join(__dirname, "data", "app.db");
const db = new DatabaseSync(dbPath);
console.log("Tables:", db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all());
try {
  console.log("Campaigns:", db.prepare("SELECT * FROM campaigns").all());
  console.log("Milestones:", db.prepare("SELECT * FROM milestones").all());
  console.log("Credentials:", db.prepare("SELECT * FROM credentials").all());
} catch (e) {
  console.error("Error:", e.message);
}
