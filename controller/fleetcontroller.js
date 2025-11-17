const fs = require("fs");
const path = require("path");
const xml2js = require("xml2js");
const smartinventory = require("./smartinventory"); // make sure this is installed

const pool = require("../db");

async function getAllExternalFilesWithPreview(req, res) {
  let connection;
  try {
    const { st_name, dt_name, blk_name } = req.query; 

    connection = await pool.getConnection();

    // 1️⃣ Build conditions dynamically
    const conditions = [];
    const params = [];

    if (st_name) {
      conditions.push("st_name = ?");
      params.push(st_name);
    }
    if (dt_name) {
      conditions.push("dt_name = ?");
      params.push(dt_name);
    }
    if (blk_name) {
      conditions.push("blk_name = ?");
      params.push(blk_name);
    }

    const whereClause = conditions.length
      ? `WHERE ${conditions.join(" AND ")}`
      : "";

    // 2️⃣ Get all networks with optional filters
    const [networks] = await connection.query(
      `SELECT * FROM networks ${whereClause}`,
      params
    );

    // 3️⃣ For each network, fetch points + connections
    const results = [];
    for (const net of networks) {
     

      const [connections] = await connection.query(
        `SELECT * FROM connections WHERE network_id = ?`,
        [net.id]
      );

      results.push({
        ...net,
        connections,
      });
    }

    res.json({
      status: true,
      filters: { st_name, dt_name, blk_name },
      total: results.length,
      data: results,
    });
  } catch (error) {
    console.error("Error in getDesktopPlanning:", error);
    return res.status(500).json({
      status: false,
      error: error.message,
    });
  } finally {
    if (connection) connection.release();
  }
}



// async function getExternalFiles(req, res) {
//     let connection;
//     try {
//         const { state_name, dist_name, blk_name, filename } = req.query;

//         let query = `
//             SELECT ed.id, s.state_name, d.dist_name, b.blk_name, ed.filename, ed.file_type, ed.category, ed.filepath, ed.data_id, ed.uploaded_at
//             FROM external_data ed
//             JOIN states s ON ed.state_code = s.state_id
//             JOIN districts d ON ed.dist_code = d.district_id
//             JOIN blocks b ON ed.blk_code = b.block_id
//             WHERE ed.category = 'BSNL_Cables'
//         `;

//         const params = [];

//         if (state_name) {
//             query += ' AND s.state_name = ?';
//             params.push(state_name);
//         }
//         if (state_name && dist_name) {
//             query += ' AND d.dist_name = ?';
//             params.push(dist_name);
//         }
//         if (dist_name && blk_name) {
//             query += ' AND b.blk_name = ?';
//             params.push(blk_name);
//         } else if (blk_name && !dist_name) {
//             return res.status(400).json({ error: 'blk_name filter requires dist_name' });
//         }

//         if (filename) {
//             query += ' AND ed.filename LIKE ?';
//             params.push(`%${filename}%`);
//         }

//         connection = await pool.getConnection();
//         const [rows] = await connection.execute(query, params);

//         const groupedByDataId = rows.reduce((acc, row) => {
//             const rowWithUrl = { ...row, file_url: `/externaldata/${row.filepath}` };
//             const existingGroup = acc.find(group => group[0]?.data_id === row.data_id);
//             if (existingGroup) {
//                 existingGroup.push(rowWithUrl);
//             } else {
//                 acc.push([rowWithUrl]);
//             }
//             return acc;
//         }, []);

//         res.json({
//             message: 'Files retrieved successfully',
//             data: groupedByDataId
//         });

//     } catch (err) {
//         console.error('Error:', err);
//         if (err.message.includes("Table 'external_data' does not exist")) {
//             res.status(500).json({ error: 'Table external_data not found', code: 'TABLE_NOT_FOUND' });
//         } else {
//             res.status(500).json({ error: 'Server error', code: 'SERVER_ERROR' });
//         }
//     } finally {
//         if (connection) connection.release();
//     }
// };



async function getExternalFiles(req, res) {
    let connection;
    try {
        connection = await pool.getConnection();

        // 1️⃣ Fetch all files with category 'BSNL_Cables' and optional filters
        const { state_name, dist_name, blk_name } = req.query;

        let query = `
            SELECT ed.id, s.state_name, d.district_name, b.block_name, ed.filename, ed.file_type, ed.category, ed.filepath, ed.data_id, ed.uploaded_at
            FROM external_data ed
            JOIN states s ON ed.state_code = s.state_id
            JOIN districts d ON ed.dist_code = d.district_id
            JOIN blocks b ON ed.blk_code = b.block_id
            WHERE ed.category = 'BSNL_Cables'
        `;
        const params = [];

        if (state_name) {
            query += ' AND s.state_name = ?';
            params.push(state_name);
        }
        if (state_name && dist_name) {
            query += ' AND d.district_name = ?';
            params.push(dist_name);
        }
        if (dist_name && blk_name) {
            query += ' AND b.block_name = ?';
            params.push(blk_name);
        } else if (blk_name && !dist_name) {
            return res.status(400).json({ error: 'blk_name filter requires dist_name' });
        }

        const [files] = await connection.execute(query, params);

        if (!files.length) {
            return res.json({ message: 'No files found', data: [] });
        }

        // 2️⃣ Parse each KMZ file
        const results = [];
        for (const file of files) {
            const fullPath = path.resolve(__dirname, '..', file.filepath);

            if (!fs.existsSync(fullPath)) {
                results.push({ ...file, error: 'File not found' });
                continue;
            }

            try {
                const buffer = fs.readFileSync(fullPath);
                const parsedResult = smartinventory.parseKmz(buffer);

                const parsedData = {
                    points: parsedResult.points.map(p => ({
                        name: p.name,
                        type: p.type || 'point',
                        coordinates: { longitude: p.coordinates[0], latitude: p.coordinates[1] },
                        properties: p.properties
                    })),
                    polylines: parsedResult.lines.map(line => ({
                        name: line.name,
                        type: line.type || 'line',
                        coordinates: line.coordinates,
                        properties: line.properties,
                        distance: line.length ? parseFloat(line.length) : null
                    }))
                };

                const summary = {
                    points: parsedData.points.length,
                    polylines: parsedData.polylines.length
                };

                results.push({
                    ...file,
                    parsed_data: parsedData,
                    summary
                });

            } catch (parseErr) {
                console.error('Error parsing KMZ:', parseErr);
                results.push({ ...file, error: 'Failed to parse KMZ file' });
            }
        }

        res.json({
            message: 'Files fetched and parsed successfully',
            data: results
        });

    } catch (err) {
        console.error('Server error:', err);
        res.status(500).json({ error: 'Server error', code: 'SERVER_ERROR' });
    } finally {
        if (connection) connection.release();
    }
}


const  pool2  = require("../fleetdb"); // adjust path if needed

async function testConnections(req, res) {
  try {
    const [rows2] = await pool2.query("SELECT DATABASE()");
    console.log("Remote DB:", rows2);
     res.status(200).json({data: rows2});
  } catch (err) {
    console.error("❌ Connection error:", err);
     res.status(500).json({ error: err, code: 'SERVER_ERROR' });
  }
}



module.exports = { testConnections, getAllExternalFilesWithPreview, getExternalFiles };
