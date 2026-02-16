const mysql = require("mysql2/promise");

const dbConfig = { 
    host: "localhost",
    port: 3306,
    user: "root",
    password: "AllowTsl@1234",
    database: "tracking",
    connectTimeout: 10000, // 10 seconds
    connectionLimit: 10,
    waitForConnections: true,
};

const pool = mysql.createPool(dbConfig);

module.exports = pool;
