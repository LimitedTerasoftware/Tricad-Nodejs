const cron = require("node-cron");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");

// Common backup folder
const BACKUP_DIR = path.join(__dirname, "../backups");

// Utility function to ensure directory exists
function ensureDirExists(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

//---------------- 🔹 BACKUP FUNCTION 1: Remote westbengal DB ----------------
 async function backupWestBengalDB() {
  const DB_USER = "root";
  const DB_PASS = "JayaM@786O";
  const DB_NAME = "westbengal";
  const DB_HOST = "192.168.12.32";
  const DB_PORT = 3306;
   ensureDirExists(BACKUP_DIR);
  const fileName = `${DB_NAME}_${new Date().toISOString().replace(/[:.]/g, "-")}.sql`;
 const filePath = path.join(BACKUP_DIR, fileName);
const dumpCommand = `mysqldump -h ${DB_HOST} -P ${DB_PORT} -u ${DB_USER} -p${DB_PASS} ${DB_NAME} > "${filePath}"`;

console.log(`🧠 Starting backup for DB: ${DB_NAME}`);
exec(dumpCommand, (error) => {
  if (error) {
    console.error(`❌ Backup failed for ${DB_NAME}:`, error.message);
    return;
    }
    console.log(`✅ Backup created successfully for ${DB_NAME}: ${filePath}`);

     // Clean up old files older than 7 days
   const cleanCmd = `find ${BACKUP_DIR} -type f -name "${DB_NAME}_*.sql" -mtime +7 -delete`;
   exec(cleanCmd, () => console.log(`🧹 Old ${DB_NAME} backups cleaned up`));
 });
 }

// --------------- 🔹 BACKUP FUNCTION 2: Local tracking DB ----------------
async function backupTrackingDB() {
  const DB_USER = "pmadmin";
  const DB_PASS = "AllowTsl";
  const DB_NAME = "tracking";
  const DB_HOST = "localhost";
  const DB_PORT = 3306;

  ensureDirExists(BACKUP_DIR);

  const fileName = `${DB_NAME}_${new Date().toISOString().replace(/[:.]/g, "-")}.sql`;
  const filePath = path.join(BACKUP_DIR, fileName);
  const dumpCommand = `mysqldump -h ${DB_HOST} -P ${DB_PORT} -u ${DB_USER} -p${DB_PASS} ${DB_NAME} > "${filePath}"`;

  console.log(`🧠 Starting backup for DB: ${DB_NAME}`);
  exec(dumpCommand, (error) => {
    if (error) {
      console.error(`❌ Backup failed for ${DB_NAME}:`, error.message);
      return;
    }
    console.log(`✅ Backup created successfully for ${DB_NAME}: ${filePath}`);

    // Clean up old files older than 7 days
    const cleanCmd = `find ${BACKUP_DIR} -type f -name "${DB_NAME}_*.sql" -mtime +7 -delete`;
    exec(cleanCmd, () => console.log(`🧹 Old ${DB_NAME} backups cleaned up`));
  });
}

// --------------- 🔹 CRON JOB SCHEDULING ----------------
// Runs both backups every day at 2:00 AM
cron.schedule("0 2 * * *", () => {
 console.log("🚀 Running scheduled DB backups...");
 //backupWestBengalDB();
  backupTrackingDB();
});




// Export functions in case you want to trigger manually too
module.exports = {
 //backupWestBengalDB,
  backupTrackingDB,
};
