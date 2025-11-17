const pool = require("../db");

// âœ… Create Block Installation
async function createBlockInstallation(req, res) {
  let connection;
  try {
    const allowedFields = [
      "user_id", "state_code", "district_code", "block_code", "block_name",
      "block_latitude", "block_longitude", "block_photos", "smart_rack",
      "fdms_shelf", "ip_mpls_router","fiber_entry", 'splicing_photo',
      "sfp_10g_40", "sfp_1g_10", "sfp_10g_10",
      "rfms", "equipment_photo", "block_contacts", "RFMS_FILTER"
    ];

    const body = req.body;
    const columns = [];
    const values = [];
    const placeholders = [];

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

    connection = await pool.getConnection();
    await connection.beginTransaction();

    const query = `
      INSERT INTO block_installation (${columns.join(", ")})
      VALUES (${placeholders.join(", ")})
    `;

    await connection.query(query, values);
    await connection.commit();

    res.status(201).json({
      status: true,
      message: "Block Installation data saved successfully"
    });

  } catch (error) {
    if (connection) await connection.rollback();
    console.error("Error saving block_installation data:", error);
    res.status(500).json({ status: false, error: error.message });
  } finally {
    if (connection) connection.release();
  }
}

  async function getAllBlockInstallations(req, res) {
  let connection;
  try {
    const {id, user_id, state_code, district_code, block_code } = req.query;

    const conditions = [];
    const params = [];

       if (id) {
      conditions.push("bi.id = ?");
      params.push(id);
    }

    if (user_id) {
      conditions.push("bi.user_id = ?");
      params.push(user_id);
    }
    if (state_code) {
      conditions.push("bi.state_code = ?");
      params.push(state_code);
    }
    if (district_code) {
      conditions.push("bi.district_code = ?");
      params.push(district_code);
    }
    if (block_code) {
      conditions.push("bi.block_code = ?");
      params.push(block_code);
    }

    connection = await pool.getConnection();

    const whereClause = conditions.length
      ? `WHERE ${conditions.join(" AND ")}`
      : "";

    const [rows] = await connection.execute(
      `SELECT 
          bi.*, 
          s.state_name, 
          d.district_name
       FROM block_installation bi
       LEFT JOIN states s ON bi.state_code = s.state_code
       LEFT JOIN districts d 
          ON bi.state_code = d.state_code 
          AND bi.district_code = d.district_code
       ${whereClause}
       ORDER BY bi.id DESC`,
      params
    );

    res.status(200).json({
      status: true,
      totalRows: rows.length,
      filters: { user_id, state_code, district_code, block_code },
      data: rows
    });

  } catch (error) {
    console.error("Error fetching block_installation data:", error);
    res.status(500).json({ status: false, error: error.message });
  } finally {
    if (connection) connection.release();
  }
}

// âœ… Update Block Installation
async function updateBlockInstallation(req, res) {
  let connection;
  try {
    const allowedFields = [
      "user_id", "state_code", "district_code", "block_code", "block_name", 
      "block_latitude", "block_longitude", "block_photos", "smart_rack",
      "fdms_shelf", "ip_mpls_router","fiber_entry", 'splicing_photo',
       "sfp_10g_40", "sfp_1g_10", "sfp_10g_10",
      "rfms", "equipment_photo", "block_contacts", "RFMS_FILTER"
    ];

    const body = req.body;
    const updates = [];
    const values = [];

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

    if (!body.id) {
      return res.status(400).json({ status: false, message: "id is required to update." });
    }

    values.push(body.id);

    connection = await pool.getConnection();
    await connection.beginTransaction();

    const query = `
      UPDATE block_installation
      SET ${updates.join(", ")}
      WHERE id = ?
    `;

    const [result] = await connection.query(query, values);
    await connection.commit();

    if (result.affectedRows === 0) {
      return res.status(404).json({ status: false, message: "No record found for given id" });
    }

    res.status(200).json({
      status: true,
      message: "Block Installation data updated successfully"
    });

  } catch (error) {
    if (connection) await connection.rollback();
    console.error("Error updating block_installation data:", error);
    res.status(500).json({ status: false, error: error.message });
  } finally {
    if (connection) connection.release();
  }
}

async function getBlockInstallationHistoryByUser(req, res) {
    let connection;
    try {
        const { user_id } = req.query;

        if (!user_id) {
            return res.status(400).json({ status: false, error: "Missing user_id in query" });
        }

        connection = await pool.getConnection();

        const query = `
            SELECT
                bi.id,
                bi.block_code,
                bi.block_name,
                bi.block_contacts,
                bi.block_latitude,
                bi.block_longitude,
                bi.smart_rack,
                bi.fdms_shelf,
                bi.ip_mpls_router,
                bi.sfp_10g_40,
                bi.sfp_1g_10,
                bi.sfp_10g_10,
                bi.rfms,
                bi.RFMS_FILTER,
                bi.equipment_photo,
                bi.fiber_entry,
                bi.splicing_photo,
                s.state_name,
                d.district_name
            FROM block_installation bi
            LEFT JOIN states s 
                ON bi.state_code = s.state_code
            LEFT JOIN districts d 
                ON bi.state_code = d.state_code 
                AND bi.district_code = d.district_code
            WHERE bi.user_id = ?
            ORDER BY bi.created_at DESC
        `;

        const [rows] = await connection.query(query, [user_id]);

        // Now calculate status
        const history = rows.map((row) => {
            const checkFields = [
                row.smart_rack,
                row.fdms_shelf,
                row.ip_mpls_router,
                row.sfp_10g_40,
                row.sfp_1g_10,
                row.sfp_10g_10,
                row.rfms,
                row.RFMS_FILTER,
                row.equipment_photo,
                row.fiber_entry,
                row.splicing_photo,
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

            return {
                ...row,
                status: isIncomplete ? "InProgress" : "Completed",
            };
        });

        return res.status(200).json({ status: true, history });

    } catch (error) {
        console.error("Error in getBlockInstallationHistoryByUser:", error);
        res.status(500).json({ status: false, error: error.message || "Internal server error" });
    } finally {
        if (connection) connection.release();
    }
}


 async function deleteBlockInstallation (req, res)  {
  let connection;
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        status: false,
        message: "Missing block_installation id",
      });
    }

    connection = await pool.getConnection();

    // Check if record exists
    const [existing] = await connection.query(
      "SELECT id FROM block_installation WHERE id = ?",
      [id]
    );

    if (existing.length === 0) {
      return res.status(404).json({
        status: false,
        message: "Record not found",
      });
    }

    // Delete the record
    await connection.query("DELETE FROM block_installation WHERE id = ?", [id]);

    res.status(200).json({
      status: true,
      message: `Block Installation record with ID ${id} deleted successfully`,
    });
  } catch (error) {
    console.error("Error deleting Block Installation:", error);
    res.status(500).json({
      status: false,
      error: error.message || "Internal server error",
    });
  } finally {
    if (connection) connection.release();
  }
};



module.exports = {
  createBlockInstallation,
  getAllBlockInstallations,
  updateBlockInstallation,
getBlockInstallationHistoryByUser,
deleteBlockInstallation 
};
