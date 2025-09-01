const mysql = require("mysql2/promise");

const dbConfig = { 
    host: "localhost",
    port: 3306,
    user: "pmadmin",
    password: "AllowTsl",
    database: "tracking",
    connectTimeout: 10000, // 10 seconds
    connectionLimit: 10,
    waitForConnections: true,
};

const pool = mysql.createPool(dbConfig);

module.exports = pool;