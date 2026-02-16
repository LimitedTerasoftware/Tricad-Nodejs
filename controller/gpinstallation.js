const pool = require("../db");

async function createInstallation(req, res) {
  let connection;
  try {
    // 1. whitelist of fields from gp_installation table
    const allowedFields = [
      'user_id', 'state_code', 'district_code', 'block_code', 'gp_code', 'gp_name',
      'gp_latitude', 'gp_longitude', 'gp_photos',
      'smart_rack', 'fdms_shelf', 'ip_mpls_router',
      'sfp_10g_40', 'sfp_1g_10',  'sfp_10g_10',
      'power_system_with_mppt', 'power_system_with_out_mppt',
      'mppt_solar_1kw', 'equipment_photo', 'RFMS_FILTERS',
      'earthpit', 'gp_contact', 'key_person'
    ];

    const body = req.body;
    const columns = [];
    const values = [];
    const placeholders = [];

    // 2. Collect only provided fields
    for (const field of allowedFields) {
      if (body[field] !== undefined) {
        columns.push(field);
        const value = (Array.isArray(body[field]) || typeof body[field] === "object")
          ? JSON.stringify(body[field])
          : body[field];
        values.push(value);
        placeholders.push("?");
      }
    }

    if (columns.length === 0) {
      return res.status(400).json({ status: false, message: "No valid data provided." });
    }

    // 3. DB Transaction
    connection = await pool.getConnection();
    await connection.beginTransaction();

    const query = `
      INSERT INTO gp_installation (${columns.join(", ")})
      VALUES (${placeholders.join(", ")})
    `;

    await connection.query(query, values);
    await connection.commit();

    // 4. Respond
    res.status(201).json({
      status: true,
      message: "GP Installation data saved successfully"
    });

  } catch (error) {
    if (connection) await connection.rollback();
    console.error("Error saving gp_installation data:", error);
    res.status(500).json({
      status: false,
      error: error.message
    });
  } finally {
    if (connection) connection.release();
  }
}




// âœ… Get all GP Installation records (with optional filters)
       async function getAllInstallations(req, res) {
  let connection;
  try {
    const {id, user_id, state_code, district_code, block_code, gp_code } =
      req.query;

    const conditions = [];
    const params = [];

       if (id) {
      conditions.push("gi.id = ?");
      params.push(id);
    }

    if (user_id) {
      conditions.push("gi.user_id = ?");
      params.push(user_id);
    }
    if (state_code) {
      conditions.push("gi.state_code = ?");
      params.push(state_code);
    }
    if (district_code) {
      conditions.push("gi.district_code = ?");
      params.push(district_code);
    }
    if (block_code) {
      conditions.push("gi.block_code = ?");
      params.push(block_code);
    }
    if (gp_code) {
      conditions.push("gi.gp_code = ?");
      params.push(gp_code);
    }

       connection = await pool.getConnection();
    await connection.beginTransaction();


    const whereClause = conditions.length
      ? `WHERE ${conditions.join(" AND ")}`
      : "";

    const [rows] = await connection.execute(
      `SELECT gi.*, 
                  s.state_name, 
                  d.district_name, 
                  b.block_name
          FROM gp_installation gi
          LEFT JOIN states s ON gi.state_code = s.state_code
          LEFT JOIN districts d ON gi.district_code = d.district_code
          LEFT JOIN blocks b ON gi.block_code = b.block_code
          ${whereClause}
          ORDER BY gi.id DESC`,
      params
    );

    res.status(200).json({
      status: true,
      totalRows: rows.length,
      filters: { user_id, state_code, district_code, block_code, gp_code },
      data: rows,
    });
  } catch (error) {
    console.error("Error fetching gp_installation data:", error);
    res.status(500).json({
      status: false,
      message: "Internal Server Error",
      error: error.message,
    });
  } finally {
    if (connection) connection.release();
  }
}

async function updateInstallation(req, res) {
  let connection;
  try {
    // 1. whitelist of fields from gp_installation table
    const allowedFields = [
      'user_id', 'state_code', 'district_code', 'block_code', 'gp_code', 'gp_name',
      'gp_latitude', 'gp_longitude', 'gp_photos',
      'smart_rack', 'fdms_shelf', 'ip_mpls_router',
      'sfp_10g_40', 'sfp_1g_10',  'sfp_10g_10', 'RFMS_FILTERS',
      'power_system_with_mppt', 'power_system_with_out_mppt',
      'mppt_solar_1kw', 'equipment_photo',
      'earthpit', 'gp_contact', 'key_person'
    ];

    const body = req.body;
    const updates = [];
    const values = [];

    // 2. Collect only provided fields
    for (const field of allowedFields) {
      if (body[field] !== undefined) {
        const value = (Array.isArray(body[field]) || typeof body[field] === "object")
          ? JSON.stringify(body[field])
          : body[field];
        updates.push(`${field} = ?`);
        values.push(value);
      }
    }

    if (updates.length === 0) {
      return res.status(400).json({ status: false, message: "No valid fields to update." });
    }

    // 3. Require `id` to update
    if (!body.id) {
      return res.status(400).json({ status: false, message: "id is required to update." });
    }

    values.push(body.id);

    // 4. DB Transaction
    connection = await pool.getConnection();
    await connection.beginTransaction();

    const query = `
      UPDATE gp_installation
      SET ${updates.join(", ")}
      WHERE id = ?
    `;

    const [result] = await connection.query(query, values);
    await connection.commit();

    if (result.affectedRows === 0) {
      return res.status(404).json({ status: false, message: "No record found for given id" });
    }

    // 5. Respond
    res.status(200).json({
      status: true,
      message: "GP Installation data updated successfully"
    });

  } catch (error) {
    if (connection) await connection.rollback();
    console.error("Error updating gp_installation data:", error);
    res.status(500).json({
      status: false,
      error: error.message
    });
  } finally {
    if (connection) connection.release();
  }
}


 
async function getGPInstallationHistoryByUser(req, res) {
    let connection;
    try {
        const { user_id } = req.query;

        if (!user_id) {
            return res.status(400).json({ status: false, error: "Missing user_id in query" });
        }

        connection = await pool.getConnection();

        const query = `
            SELECT
                gpi.id,
                gpi.gp_name,
                gpi.gp_latitude,
                gpi.gp_longitude,
                gpi.gp_contact,
                gpi.gp_photos,
                gpi.smart_rack,
                gpi.fdms_shelf,
                gpi.ip_mpls_router,
                gpi.RFMS_FILTERS,
                gpi.sfp_10g_40,
                gpi.sfp_1g_10,
                gpi.sfp_10g_10,
                gpi.power_system_with_mppt,
                gpi.power_system_with_out_mppt,
                gpi.mppt_solar_1kw,
                gpi.equipment_photo,
                
                gpi.earthpit,
                s.state_name,
                d.district_name,
                b.block_name
            FROM gp_installation gpi
            LEFT JOIN states s ON gpi.state_code = s.state_code
            LEFT JOIN districts d 
                ON gpi.state_code = d.state_code 
                AND gpi.district_code = d.district_code
            LEFT JOIN blocks b 
                ON gpi.state_code = b.state_code 
                AND gpi.district_code = b.district_code
                AND gpi.block_code = b.block_code
            WHERE gpi.user_id = ?
            ORDER BY gpi.created_at DESC
        `;

        const [rows] = await connection.query(query, [user_id]);

        const history = rows.map((row) => {
            const checkFields = [
                row.gp_photos,
                row.smart_rack,
                row.fdms_shelf,
                row.ip_mpls_router,
                row.sfp_10g_40,
                row.sfp_1g_10,
                row.sfp_10g_10,
                row.RFMS_FILTERS,
                row.power_system_with_mppt,
                row.power_system_with_out_mppt,
                row.mppt_solar_1kw,
                row.equipment_photo,
                row.earthpit,
            ];

                  // Parse JSON safely and check if any field is empty
            const isIncomplete = checkFields.some((field) => {
                try {
                    const val = JSON.parse(field || "[]" || "{}");
                    return Array.isArray(val) ? val.length === 0 : Object.keys(val).length === 0;
                } catch {
                    return true; // if invalid JSON, treat as incomplete
                }
            });

             console.log(isIncomplete,"complete")

            return {
                ...row,
                status: isIncomplete ? "InProgress" : "Completed",
            };
        });

        return res.status(200).json({ status: true, history });

    } catch (error) {
        console.error("Error in getGPInstallationHistoryByUser:", error);
        res.status(500).json({ status: false, error: error.message || "Internal server error" });
    } finally {
        if (connection) connection.release();
    }
}

async function deleteInstallation (req, res)  {
  let connection;
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        status: false,
        message: "Missing gp_installation id",
      });
    }

    connection = await pool.getConnection();

    // Check if record exists
    const [existing] = await connection.query(
      "SELECT id FROM gp_installation WHERE id = ?",
      [id]
    );

    if (existing.length === 0) {
      return res.status(404).json({
        status: false,
        message: "Record not found",
      });
    }

    // Delete the record
    await connection.query("DELETE FROM gp_installation WHERE id = ?", [id]);

    res.status(200).json({
      status: true,
      message: `GP Installation record with ID ${id} deleted successfully`,
    });
  } catch (error) {
    console.error("Error deleting GP Installation:", error);
    res.status(500).json({
      status: false,
      error: error.message || "Internal server error",
    });
  } finally {
    if (connection) connection.release();
  }
};


async function updtaeStatus (req, res)  {
  let connection;
  try {
        const { status, type, id  } = req.body; // expected values: PENDING / ACCEPT / REJECT

    // ? Validate status value
    const validStatuses = ["PENDING", "ACCEPT", "REJECT"];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid status. Allowed: PENDING, ACCEPT, REJECT",
      });
    }

    // ? Determine table name
    let tableName = "";
    if (type === "gp-installation") {
      tableName = "gp_installation";
    } else if (type === "block-installation") {
      tableName = "block_installation";
    } else {
      return res.status(400).json({
        success: false,
        message: "Invalid type. Use gp-installation or block-installation",
      });
    }

    connection = await pool.getConnection();

    const [result] = await connection.query(
      `UPDATE ${tableName} SET status = ? WHERE id = ?`,
      [status, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: "Record not found",
      });
    }

    res.json({
      success: true,
      message: `Status updated to '${status}' successfully`,
    });
  } catch (error) {
    console.error("Error updating status:", error);
    res.status(500).json({
      success: false,
      message: "Internal Server Error",
      error: error.message,
    });
  } finally {
    if (connection) connection.release();
  }
};



async function getGPBasicDetails(req, res) {
  let connection;
  try {
    connection = await pool.getConnection();

    const query = `
      SELECT 
        gi.id,
        gi.gp_name,
        gi.status,
        gi.key_person,
        gi.gp_photos,
        gi.smart_rack,
        gi.fdms_shelf,
        gi.ip_mpls_router,
        gi.RFMS_FILTERS,
        gi.sfp_10g_40,
        gi.sfp_1g_10,
        gi.sfp_10g_10,
        gi.power_system_with_mppt,
        gi.power_system_with_out_mppt,
        gi.mppt_solar_1kw,
        gi.equipment_photo,
        gi.earthpit,
        u.fullname AS surveyor_name,
        u.email AS surveyor_email,
        u.version AS surveyor_version,
        s.state_name,
        d.district_name,
        b.block_name
      FROM gp_installation gi
      LEFT JOIN users u ON gi.user_id = u.id
      LEFT JOIN states s ON gi.state_code = s.state_code
      LEFT JOIN districts d ON gi.district_code = d.district_code
      LEFT JOIN blocks b ON gi.block_code = b.block_code
      ORDER BY gi.created_at DESC
    `;

    const [rows] = await connection.query(query);

    const result = rows.map((row) => {
      // Parse key_person JSON safely
      let keyPerson = {};
      try {
        keyPerson = row.key_person ? JSON.parse(row.key_person) : {};
      } catch {
        keyPerson = { name: row.key_person || "N/A" };
      }

      // Equipment progress check
      const checkFields = [
        row.gp_photos,
        row.smart_rack,
        row.fdms_shelf,
        row.ip_mpls_router,
        row.RFMS_FILTERS,
        row.sfp_10g_40,
        row.sfp_1g_10,
        row.sfp_10g_10,
        row.power_system_with_mppt,
        row.power_system_with_out_mppt,
        row.mppt_solar_1kw,
        row.equipment_photo,
        row.earthpit,
      ];

      const isIncomplete = checkFields.some((field) => {
        try {
          const val = JSON.parse(field || "[]" || "{}");
          return Array.isArray(val)
            ? val.length === 0
            : Object.keys(val).length === 0;
        } catch {
          return true; // treat invalid JSON as incomplete
        }
      });

      const progress = isIncomplete ? "InProgress" : "Completed";

      return {
        id: row.id,
        gp_name: row.gp_name,
        state_name: row.state_name || "N/A",
        district_name: row.district_name || "N/A",
        block_name: row.block_name || "N/A",
        status: row.status,
        progress,
        key_person: {
          name: keyPerson.name || "N/A",
          phone: keyPerson.phone || "N/A",
        },
        surveyor: {
          name: row.surveyor_name || "N/A",
          email: row.surveyor_email || "N/A",
          version: row.surveyor_version || "N/A",
        },
      };
    });

    res.json({ success: true, data: result });
  } catch (error) {
    console.error("Error fetching GP basic details:", error);
    res.status(500).json({ success: false, error: error.message });
  } finally {
    if (connection) connection.release();
  }
}


async function getGpDashboard(req, res) {
  let connection;
  try {
    const { state_code, district_code, block_code, page = 1, limit = 10 } = req.query;

    const offset = (page - 1) * limit;

    connection = await pool.getConnection();

    // ------------------------------------
    // 1??  SUMMARY — YOUR ORIGINAL CODE
    // ------------------------------------
    const [summaryRows] = await connection.query(
      `
      SELECT
          ont.total_ont_gps,
          gi.total_survey_count,
          gi.pending_count,
          gi.accepted_count,
          gi.rejected_count
      FROM
          (
              SELECT COUNT(*) AS total_ont_gps
              FROM gpslist
              WHERE type = 'ONT'
              AND (st_code = ? OR ? IS NULL)
              AND (dt_code = ? OR ? IS NULL)
              AND (blk_code = ? OR ? IS NULL)
          ) AS ont,
          (
              SELECT
                  COUNT(*) AS total_survey_count,
                  SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) AS pending_count,
                  SUM(CASE WHEN status = 'ACCEPT' THEN 1 ELSE 0 END) AS accepted_count,
                  SUM(CASE WHEN status = 'REJECT' THEN 1 ELSE 0 END) AS rejected_count
              FROM gp_installation
              WHERE (state_code = ? OR ? IS NULL)
              AND (district_code = ? OR ? IS NULL)
              AND (block_code = ? OR ? IS NULL)
          ) AS gi
      `,
      [
        state_code, state_code,
        district_code, district_code,
        block_code, block_code,

        state_code, state_code,
        district_code, district_code,
        block_code, block_code
      ]
    );

    const summary = summaryRows[0];

    let progress_percent = 0;
    if (summary.total_ont_gps > 0) {
      progress_percent = (
        (summary.total_survey_count / summary.total_ont_gps) * 100
      ).toFixed(2);
    }

    // ------------------------------------
    // 2?? PAGINATED TABLE DATA (FIXED)
    // ------------------------------------
    const [tableData] = await connection.query(
      `
      SELECT
          id,
          gp_name,
          gp_contact,
          key_person,
          status,
          gp_latitude,
          gp_longitude,
          created_at
      FROM gp_installation
      WHERE (state_code = ? OR ? IS NULL)
      AND (district_code = ? OR ? IS NULL)
      AND (block_code = ? OR ? IS NULL)
      ORDER BY id DESC
      LIMIT ? OFFSET ?
      `,
      [
        state_code, state_code,
        district_code, district_code,
        block_code, block_code,
        parseInt(limit),
        offset
      ]
    );

    // total records
    const [[countResult]] = await connection.query(
      `
      SELECT COUNT(*) AS total
      FROM gp_installation
      WHERE (state_code = ? OR ? IS NULL)
      AND (district_code = ? OR ? IS NULL)
      AND (block_code = ? OR ? IS NULL)
      `,
      [
        state_code, state_code,
        district_code, district_code,
        block_code, block_code
      ]
    );

    return res.json({
      success: true,
      summary: {
        ...summary,
        progress_percent
      },
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total_records: countResult.total,
        total_pages: Math.ceil(countResult.total / limit)
      },
      detailed_data: tableData
    });

  } catch (error) {
    console.log(error);
    return res.status(500).json({ success: false, error: error.message });
  } finally {
    if (connection) connection.release();
  }
}



module.exports = { createInstallation, getGpDashboard, getAllInstallations, updateInstallation, updtaeStatus, getGPBasicDetails ,  getGPInstallationHistoryByUser, deleteInstallation };
