

const mysql = require("mysql2/promise");

const dbConfig = {
  host: "127.0.0.1",
  port: 3306,
  user: "root",
  password: "JayaM@786O",
  database: "westbengal",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
}

const pool2 = mysql.createPool(dbConfig);

module.exports = pool2;