// GET /api/dashboard?state_code=19
const pool = require("../db");

async function dashboard(req, res) {
  let connection;
  try {
    const { state_code } = req.query;

    if (!state_code) {
      return res
        .status(400)
        .json({ status: false, error: "state_code is required" });
    }

    connection = await pool.getConnection();

    const [rows] = await connection.query(
      `SELECT b.block_code, bs.* 
       FROM blocks b 
       JOIN block_status bs ON b.block_code = bs.block_code
       WHERE b.state_code = ?`,
      [state_code]
    );

    const totalBlocks = rows.length;
    const assigned = rows.filter((r) => r.assigned_to !== null).length;
    const unassigned = totalBlocks - assigned;
    const overdue = rows.filter(
      (r) => r.physical_survey_status !== "Completed"
    ).length;
    const surveyProgress = (
      (rows.filter((r) => r.physical_survey_status === "Completed").length /
        totalBlocks) *
      100
    ).toFixed(0);
    const constructionProgress = (
      (rows.filter((r) => r.construction_status === "Completed").length /
        totalBlocks) *
      100
    ).toFixed(0);
    const installationProgress = (
      (rows.filter((r) => r.installation_status === "Completed").length /
        totalBlocks) *
      100
    ).toFixed(0);

    res.json({
      status: true,
      level: "state",
      state_code,
      data: {
        totalBlocks,
        assigned,
        unassigned,
        overdue,
        surveyProgress: `${surveyProgress}%`,
        constructionProgress: `${constructionProgress}%`,
        installationProgress: `${installationProgress}%`,
      },
    });
  } catch (err) {
    console.error("❌ Dashboard State API error:", err);
    res.status(500).json({ status: false, error: "Server error" });
  } finally {
    if (connection) connection.release();
  }
}

// GET /api/dashboard/blocks?state_code=19&district_code=303&stage=survey&status=In%20Progress
// async function dashboardData(req, res) {
//   let connection;

//   try {
//     const {
//       state_code,
//       district_code,
//       stage,
//       status,
//       date,
//       from_date,
//       to_date,
//     } = req.query;

//     if (!state_code || !stage) {
//       return res
//         .status(400)
//         .json({ status: false, error: "state_code and stage are required" });
//     }

//     // Map stage -> db field
//     const stageMap = {
//       survey: {
//         statusField: "physical_survey_status",
//         start: "physical_startDate",
//         end: "physical_endDate",
//       },
//       construction: {
//         statusField: "construction_status",
//         start: "construction_startDate",
//         end: "construction_endDate",
//       },
//       installation: {
//         statusField: "installation_status",
//         start: "installation_startDate",
//         end: "installation_endDate",
//       },
//       desktop: {
//         statusField: "desktop_status",
//         start: "desktop_startDate",
//         end: "desktop_endDate",
//       },
//       boq: { statusField: "boq_status", start: null, end: null },
//     };

//     if (!stageMap[stage]) {
//       return res.status(400).json({ status: false, error: "Invalid stage" });
//     }

//     const { statusField, start, end } = stageMap[stage];

//     connection = await pool.getConnection();

//     let query = `
//       SELECT 
//         b.block_code,
//         b.block_name,
//         bs.block_id,
//         bs.no_of_gps,
//         d.district_name,
//         (bs.proposed_length + bs.incremental_length) AS total_length_km,
//         ? AS stage,
//         bs.${statusField} AS status,
//         u.fullname AS assigned_to,
//         bs.progress
//         ${start ? `, bs.${start} AS start_date` : ""}
//         ${end ? `, bs.${end} AS end_date` : ""}
//       FROM blocks b
//       JOIN block_status bs ON b.block_code = bs.block_code
//       JOIN districts d ON b.district_code = d.district_code
//       LEFT JOIN users u ON bs.assigned_to = u.id
//       WHERE b.state_code = ?
//     `;

//     const params = [stage, state_code];

//     if (district_code) {
//       query += " AND b.district_code = ?";
//       params.push(district_code);
//     }
//     if (status) {
//       query += ` AND bs.${statusField} = ?`;
//       params.push(status);
//     }

//     // 📅 Date filters
//     if (date && start) {
//       // filter for a single day (today or passed date)
//       query += ` AND DATE(bs.${start}) = ?`;
//       params.push(date);
//     } else if (from_date && to_date && start) {
//       // filter for range
//       query += ` AND DATE(bs.${start}) BETWEEN ? AND ?`;
//       params.push(from_date, to_date);
//     }

//     const [rows] = await connection.query(query, params);

//     res.json({
//       status: true,
//       data: rows.map((r) => ({
//         blockName: r.block_name,
//         blockCode: r.block_code,
//         blockId: r.block_id,
//         district: r.district_name,
//         no_of_gps: r.no_of_gps,
//         length: r.total_length_km + " km",
//         stage: r.stage,
//         status: r.status,
//         assignedTo: r.assigned_to || "Unassigned",
//         progress: r.progress + "%",
//         startDate: r.start_date || null,
//         endDate: r.end_date || null,
//       })),
//     });
//   } catch (err) {
//     console.error("❌ API error:", err);
//     res.status(500).json({ status: false, error: err.message });
//   } finally {
//     if (connection) connection.release();
//   }
// }


async function dashboardData(req, res) {
  let connection;

  try {
    const {
      state_code,
      district_code,
      stage,
      status,
      date,
      from_date,
      to_date,
    } = req.query;

    if (!state_code || !stage) {
      return res
        .status(400)
        .json({ status: false, error: "state_code and stage are required" });
    }

    // Map stage -> db field
       

    if (!stageMap[stage]) {
      return res.status(400).json({ status: false, error: "Invalid stage" });
    }

    const { statusField, start, end } = stageMap[stage];

    connection = await pool.getConnection();

    // Main query
    let query = `
      SELECT 
        b.block_code,
        b.block_name,
        bs.block_id,
        bs.no_of_gps,
        d.district_name,
        (bs.proposed_length + bs.incremental_length) AS total_length_km,
        ? AS stage,
        bs.${statusField} AS status,
        u.fullname AS assigned_to,
        bs.progress,
        IFNULL(s.survey_docs,0) AS survey_docs,
        IFNULL(c.connection_docs,0) AS connection_docs,
        CASE 
        WHEN '${stage}' = 'survey' AND bs.physical_survey_status = 'Completed'
          THEN 100
        WHEN '${stage}' = 'survey' AND c.connection_docs > 0 
          THEN ROUND((s.survey_docs / c.connection_docs) * 100,2)
        WHEN '${stage}' = 'construction' AND bs.construction_status = 'Completed'
          THEN 100
        WHEN '${stage}' = 'installation' AND bs.installation_status = 'Completed'
          THEN 100
        WHEN '${stage}' = 'desktop' AND bs.desktop_status = 'Completed'
          THEN 100
        WHEN '${stage}' = 'boq' AND bs.boq_status = 'Completed'
          THEN 100
        ELSE 0
      END AS progress_percent


        ${start ? `, bs.${start} AS start_date` : ""}
        ${end ? `, bs.${end} AS end_date` : ""}
      FROM blocks b
      JOIN block_status bs ON b.block_code = bs.block_code
      JOIN districts d ON b.district_code = d.district_code
      LEFT JOIN users u ON bs.assigned_to = u.id

      -- Unique survey docs per block
      LEFT JOIN (
        SELECT 
          block_id, 
          COUNT(DISTINCT CONCAT(startLocation, '-', endLocation)) AS survey_docs
        FROM underground_fiber_surveys
        WHERE startLocation <> endLocation
          AND is_active = 1
        GROUP BY block_id
      ) s ON bs.block_id = s.block_id

      -- Expected connections per block
          LEFT JOIN (
    SELECT n.blk_code, COUNT(c.id) AS connection_docs
    FROM networks n
    JOIN connections c ON n.id = c.network_id
    WHERE n.blk_code IS NOT NULL
    GROUP BY n.blk_code
) c ON CAST(bs.block_id AS CHAR) = c.blk_code

      WHERE b.state_code = ?
    `;

    const params = [stage, state_code];

    if (district_code) {
      query += " AND b.district_code = ?";
      params.push(district_code);
    }

    if (status) {
      query += ` AND bs.${statusField} = ?`;
      params.push(status);
    }

    // Date filters
    if (date && start) {
      query += ` AND DATE(bs.${start}) = ?`;
      params.push(date);
    } else if (from_date && to_date && start) {
      query += ` AND DATE(bs.${start}) BETWEEN ? AND ?`;
      params.push(from_date, to_date);
    }

   
    const [rows] = await connection.query(query, params);

    res.json({
      status: true,
      data: rows.map((r) => ({
        blockName: r.block_name,
        blockCode: r.block_code,
        blockId: r.block_id,
        district: r.district_name,
        no_of_gps: r.no_of_gps,
        length: r.total_length_km + " km",
        stage: r.stage,
        status: r.status,
        assignedTo: r.assigned_to || "Unassigned",
        surveyDocs: r.survey_docs,
        connectionDocs: r.connection_docs,
        progress: r.progress_percent + "%",
        startDate: r.start_date || null,
        endDate: r.end_date || null,
      })),
    });
  } catch (err) {
    console.error("? API error:", err);
    res.status(500).json({ status: false, error: err.message });
  } finally {
    if (connection) connection.release();
  }
}



async function assignBlockConnections(req, res) {
  let connection;
  try {
    const { block_ids, user_id, user_name } = req.body;

    if (
      !block_ids ||
      !Array.isArray(block_ids) ||
      block_ids.length === 0 ||
      !user_id ||
      !user_name
    ) {
      return res
        .status(400)
        .json({
          success: false,
          error: "block_ids (array), user_id, and user_name are required",
        });
    }

    connection = await pool.getConnection();
    await connection.beginTransaction();

    // Convert block_ids to strings (blk_code is varchar)
    const blockIdsStr = block_ids.map(String);

    // 1️⃣ Fetch networks for these blocks
    const blockPlaceholders = blockIdsStr.map(() => "?").join(",");
    const [networks] = await connection.query(
      `SELECT id, blk_code FROM networks WHERE blk_code IN (${blockPlaceholders})`,
      blockIdsStr
    );

    if (networks.length === 0) {
      await connection.rollback();
      return res
        .status(404)
        .json({
          success: false,
          error: "No networks found for provided blocks",
        });
    }

    const networkIds = networks.map((n) => n.id);
    if (networkIds.length === 0) {
      await connection.rollback();
      return res
        .status(404)
        .json({
          success: false,
          error: "No networks have corresponding connections",
        });
    }

    // Convert user_id to string (connections.user_id is varchar)
    const userIdStr = user_id.toString();

    // 2️⃣ Update connections
    const netPlaceholders = networkIds.map(() => "?").join(",");
    const [updateResult] = await connection.query(
      `UPDATE connections
       SET user_id = ?, user_name = ?, status = 'assigned'
       WHERE network_id IN (${netPlaceholders})`,
      [userIdStr, user_name, ...networkIds]
    );


       const [blockUpdate] = await connection.query(
      `UPDATE block_status 
       SET assigned_to = ?, updated_at = NOW()
       WHERE block_id IN (${blockPlaceholders})`,
      [userIdStr,  ...blockIdsStr]
    );

    await connection.commit();

    res.json({
      success: true,
      assignedBlocks: [...new Set(networks.map((n) => n.blk_code))],
      assignedConnections: updateResult.affectedRows,
      message: `Assigned ${updateResult.affectedRows} connections of blocks [${[
        ...new Set(networks.map((n) => n.blk_code)),
      ].join(", ")}] to ${user_name}`,
    });
  } catch (err) {
    if (connection) await connection.rollback();
    console.error("❌ Block connection assignment error:", err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (connection) connection.release();
  }
}

async function getUserNetworks(req, res) {
  let connection;
  try {
    const { user_id } = req.query;
    if (!user_id)
      return res
        .status(400)
        .json({ success: false, error: "user_id is required" });

    connection = await pool.getConnection();

    // 1?? Get unique network_ids from connections assigned to this user
    const [networkIds] = await connection.query(
      `SELECT DISTINCT network_id FROM connections WHERE user_id = ?`,
      [user_id]
    );

    if (networkIds.length === 0) {
      return res.json({ success: true, networks: [] });
    }

    const ids = networkIds.map((n) => n.network_id);

    // 2?? Fetch network details from networks table
    const [networks] = await connection.query(
      `SELECT * FROM networks WHERE id IN (?)`,
      [ids]
    );

    res.json({ success: true, networks });
  } catch (err) {
    console.error("? getUserNetworks error:", err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (connection) connection.release();
  }
}

async function getNetworkConnections(req, res) {
  let connection;
  try {
    const { network_id, user_id } = req.query;

    // ✅ Validate required params
    if (!network_id) {
      return res.status(400).json({
        success: false,
        error: "network_id is required",
      });
    }

    if (!user_id) {
      return res.status(400).json({
        success: false,
        error: "user_id is required",
      });
    }

    connection = await pool.getConnection();
    await connection.beginTransaction();

    // ✅ Fetch only connections that match both network_id and user_id
    const [connections] = await connection.query(
      `SELECT * 
       FROM connections 
       WHERE network_id = ? AND user_id = ?`,
      [network_id, user_id]
    );

    if (connections.length === 0) {
      throw new Error("No connections found for the given network ID and user ID");
    }

    // ✅ Process each connection
    for (let i = 0; i < connections.length; i++) {
      // Parse coordinates JSON safely
      if (connections[i].coordinates) {
        try {
          connections[i].coordinates = JSON.parse(connections[i].coordinates);
        } catch {
          connections[i].coordinates = [];
        }
      }

      // ✅ Fetch start & end points from gpslist
      const [startPoint] = await connection.query(
        "SELECT * FROM gpslist WHERE lgd_code = ?",
        [connections[i].start]
      );

      const [endPoint] = await connection.query(
        "SELECT * FROM gpslist WHERE lgd_code = ?",
        [connections[i].end]
      );

      connections[i].start_coordinates =
        startPoint.length > 0 ? startPoint[0] : null;
      connections[i].end_coordinates =
        endPoint.length > 0 ? endPoint[0] : null;

      // ✅ Fetch network + state/district/block info
      const [network] = await connection.query(
        `SELECT id, name, st_code, st_name, dt_code, dt_name, blk_code, blk_name 
         FROM networks 
         WHERE id = ?`,
        [connections[i].network_id]
      );

      if (network.length > 0) {
        connections[i].network = network[0];

        const [stateRes] = await connection.query(
          "SELECT * FROM states WHERE state_id = ?",
          [network[0].st_code]
        );
        const [districtRes] = await connection.query(
          "SELECT * FROM districts WHERE district_id = ?",
          [network[0].dt_code]
        );
        const [blockRes] = await connection.query(
          "SELECT * FROM blocks WHERE block_id = ?",
          [network[0].blk_code]
        );

        connections[i].state = stateRes.length > 0 ? stateRes[0] : null;
        connections[i].district = districtRes.length > 0 ? districtRes[0] : null;
        connections[i].block = blockRes.length > 0 ? blockRes[0] : null;
      }
    }

    await connection.commit();

    res.status(200).json({
      success: true,
      data: { connections },
      message: "Network connections filtered by user retrieved successfully",
    });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("Error:", error.message);
    res.status(500).json({
      success: false,
      error: "Failed to get filtered network connections",
      details: error.message,
    });
  } finally {
    if (connection) connection.release();
  }
}




async function getConnectionsByBlock(req, res) {
    let connection;
    try {
        const blockId = parseInt(req.params.block_id);
        if (isNaN(blockId) || blockId <= 0) {
            return res.status(400).json({
                success: false,
                message: 'Invalid block ID'
            });
        }

        connection = await pool.getConnection();
        await connection.beginTransaction();

        // Step 1: Fetch networks for the given block_id
        const [networkRows] = await connection.query(
            'SELECT id FROM networks WHERE blk_code = ?',
            [blockId.toString()] // CAST block_id to string because blk_code is varchar
        );

        if (networkRows.length === 0) {
            return res.status(404).json({
                success: false,
                message: `No networks found for block ID ${blockId}`
            });
        }

        const networkIds = networkRows.map(n => n.id);

        // Step 2: Fetch connections for those network IDs
           const [connections] = await connection.query(
          `SELECT 
              c.*, 
              u.fullname AS user_name
          FROM connections c
          LEFT JOIN users u ON c.user_id = u.id
          WHERE c.network_id = ?`,
          [networkIds]
        );

        

        res.status(200).json({
            success: true,
            data: {
                connections
            },
            message: 'Connections retrieved successfully'
        });

    } catch (err) {
        console.error('Error fetching connections by block:', {
            message: err.message,
            code: err.code,
            stack: err.stack
        });
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve connections',
            error: err.message
        });
    } finally {
        if (connection) {
            connection.release?.();
        }
    }
}



// Update connections for a given network_id
async function updateConnectionsByNetwork(req, res) {
  let connection;
  try {
    const { network_id } = req.query;
    if (!network_id) {
      return res
        .status(400)
        .json({ success: false, error: "network_id is required" });
    }

    connection = await pool.getConnection();

    // 1️⃣ Get points for the network
    const [points] = await connection.query(
      "SELECT name, lgd_code FROM points WHERE network_id = ?",
      [network_id]
    );

    // Normalize point names
    const pointMap = {};
    points.forEach((p) => {
      let cleanName = p.name
        .replace(/\(.*?\)/g, "")
        .trim()
        .toLowerCase();
      pointMap[cleanName] = p.lgd_code;
    });

    // 2️⃣ Get connections for the network
    const [connections] = await connection.query(
      "SELECT id, original_name FROM connections WHERE network_id = ?",
      [network_id]
    );

    const updates = [];

    // 3️⃣ Match and update each connection
    for (const conn of connections) {
      const parts = conn.original_name.split(" TO ");
      if (parts.length !== 2) continue;

      const startName = parts[0].trim().toLowerCase();
      const endName = parts[1].trim().toLowerCase();

      const startCode = pointMap[startName] || "123";
      const endCode = pointMap[endName] || "123";

      await connection.query(
        "UPDATE connections SET start = ?, end = ? WHERE id = ?",
        [startCode, endCode, conn.id]
      );

      updates.push({
        connection_id: conn.id,
        original_name: conn.original_name,
        start: startCode,
        end: endCode,
      });
    }

    res.json({ success: true, network_id, updates });
  } catch (err) {
    console.error("❌ updateConnectionsByNetwork error:", err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (connection) connection.release();
  }
}

// POST /start-physical-survey
async function startPhysicalSurveyDate(req, res) {
  let connection;
  try {
    const { block_id } = req.body;
    if (!block_id) {
      return res
        .status(400)
        .json({ success: false, error: "block_id is required" });
    }

    connection = await pool.getConnection();

    // 1️⃣ Check block_status for given block_id
    const [block] = await connection.query(
      `SELECT id, physical_startDate, physical_survey_status 
       FROM block_status 
       WHERE block_id = ?`,
      [block_id]
    );

    if (block.length === 0) {
      return res
        .status(404)
        .json({ success: false, error: "Block not found in block_status" });
    }

    const currentBlock = block[0];

    // 2️⃣ If already in progress and has a startDate → do nothing
    if (
      currentBlock.physical_survey_status === "In Progress" &&
      currentBlock.physical_startDate !== null
    ) {
      return res.json({
        success: true,
        message: "Block survey already in progress. No update done.",
      });
    }

    // 3️⃣ If status is "Not started" OR NULL → fetch first record from underground_fiber_surveys
    if (
      currentBlock.physical_survey_status === "Not started" ||
      currentBlock.physical_survey_status === null
    ) {
      const [survey] = await connection.query(
        `SELECT created_at 
     FROM underground_fiber_surveys 
     WHERE block_id = ? 
     ORDER BY id ASC 
     LIMIT 1`,
        [block_id]
      );

      if (survey.length === 0) {
        return res
          .status(404)
          .json({ success: false, error: "No survey found for this block_id" });
      }

      const surveyDate = survey[0].created_at;

      await connection.query(
        `UPDATE block_status 
     SET physical_startDate = ?, physical_survey_status = 'In Progress'
     WHERE block_id = ?`,
        [surveyDate, block_id]
      );

      return res.json({
        success: true,
        message: "Block survey updated to In Progress",
        updated_startDate: surveyDate,
      });
    }
  } catch (err) {
    console.error("❌ startPhysicalSurvey error:", err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (connection) connection.release();
  }
}


// ✅ Update Physical End Date API
async function updatePhysicalEndDate(req, res) {
  let connection;
  try {
    const { block_id, end_date } = req.body;

    if (!block_id || !end_date) {
      return res.status(400).json({
        success: false,
        error: "block_id and end_date are required",
      });
    }

    connection = await pool.getConnection();

    // Update end date and mark as Completed
    const [result] = await connection.query(
      `UPDATE block_status 
       SET physical_endDate = ?, physical_survey_status = 'Completed'
       WHERE block_id = ?`,
      [end_date, block_id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        error: `No block found with ID ${block_id}`,
      });
    }

    res.json({
      success: true,
      message: `Physical survey end date updated for block_id ${block_id}`,
    });
  } catch (err) {
    console.error("❌ Error updating physical_endDate:", err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (connection) connection.release();
  }
}


// ✅ Generic Update API for block_status
async function updateBlockStatus(req, res) {
  let connection;
  try {
    const { block_id, updates } = req.body;

    if (!block_id || !updates || typeof updates !== "object") {
      return res.status(400).json({
        success: false,
        error: "block_id and updates object are required",
      });
    }

    const fields = Object.keys(updates);
    const values = Object.values(updates);

    if (fields.length === 0) {
      return res.status(400).json({
        success: false,
        error: "No fields to update",
      });
    }

    const setClause = fields.map((f) => `${f} = ?`).join(", ");

    connection = await pool.getConnection();
    await connection.beginTransaction();

    // 1️⃣ Update block_status
    const [result] = await connection.query(
      `UPDATE block_status SET ${setClause} WHERE block_id = ?`,
      [...values, block_id]
    );

    if (result.affectedRows === 0) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        error: `No block found with ID ${block_id}`,
      });
    }

    // 2️⃣ Only if physical_survey_status is Completed
    if (updates.physical_survey_status === "Completed") {
      // Get blk_code of the block
        const blk_code = block_id;

        // Update all connections linked to networks of this block
        await connection.query(
          `UPDATE connections c
           JOIN networks n ON c.network_id = n.id
           SET c.status = 'Completed'
           WHERE n.blk_code = ?`,
          [blk_code]
        );
      
    }

    await connection.commit();

    res.json({
      success: true,
      message: `Block status updated for block_id ${block_id}${
        updates.physical_survey_status === "Completed"
          ? " and related connections marked Completed"
          : ""
      }`,
    });

  } catch (err) {
    if (connection) await connection.rollback();
    console.error("❌ Error updating block_status:", err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (connection) connection.release();
  }
}



///-----------------------------------------------Survey dahsboard apis--------------------------------------------------------------------------------

async function surveyCount (req, res){
  let connection;
  try {
    const { state_code } = req.query;
    if (!state_code) {
      return res.status(400).json({ success: false, error: "state_code is required" });
    }

    connection = await pool.getConnection();

    const [rows] = await connection.query(
      `SELECT 
          SUM(CASE WHEN bs.physical_survey_status = 'Completed' THEN 1 ELSE 0 END) AS completed,
          SUM(CASE WHEN bs.physical_survey_status = 'In Progress' THEN 1 ELSE 0 END) AS in_progress,
          SUM(CASE WHEN bs.physical_survey_status = 'Not started' THEN 1 ELSE 0 END) AS not_started,
          COUNT(*) AS total
       FROM blocks b
       JOIN block_status bs ON b.block_code = bs.block_code
       WHERE b.state_code = ?`,
      [state_code]
    );

    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error("Error fetching dashboard data:", err);
    res.status(500).json({ success: false, error: "Internal Server Error" });
  } finally {
    if (connection) connection.release();
  }
}


async function surveyCountByUser(req, res) {
  let connection;
  try {
    connection = await pool.getConnection();

    const [rows] = await connection.query(
      `
      SELECT
        u.id AS user_id,
        u.fullname AS username,
        u.email,
        u.version,
        c.name AS company_name,
       SUM(CASE WHEN LOWER(TRIM(con.status)) = 'completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN LOWER(TRIM(con.status)) = 'assigned' THEN 1 ELSE 0 END) AS assigned,
      SUM(CASE WHEN LOWER(TRIM(con.status)) = 'inprogress' THEN 1 ELSE 0 END) AS in_progress,
      SUM(CASE WHEN LOWER(TRIM(con.status)) = 'pending' THEN 1 ELSE 0 END) AS pending

        COUNT(*) AS total_connections,
        SUM(con.length) AS total_kms
      FROM connections con
      LEFT JOIN users u ON con.user_id = u.id
      LEFT JOIN companies c ON u.company_id = c.id
      WHERE con.user_id IS NOT NULL
      GROUP BY u.id, u.fullname, u.email, u.version, c.name
      ORDER BY completed DESC;
      `
    );

    res.json({ success: true, data: rows });
  } catch (err) {
    console.error("Error fetching connection counts:", err);
    res.status(500).json({ success: false, error: "Internal Server Error" });
  } finally {
    if (connection) connection.release();
  }
}



module.exports = {
  dashboard,
  dashboardData,
  assignBlockConnections,
  getUserNetworks,
  getNetworkConnections,
  updateConnectionsByNetwork,
  startPhysicalSurveyDate,
  updatePhysicalEndDate,
  updateBlockStatus,
  getConnectionsByBlock,
  surveyCount,
  surveyCountByUser
};
