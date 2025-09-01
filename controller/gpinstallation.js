const pool = require("../db");

async function createInstallation(req, res) {
  let connection;
  try {
    // 1. whitelist of fields from gp_installation table
    const allowedFields = [
      'user_id', 'state_code', 'district_code', 'block_code', 'gp_code', 'gp_name',
      'gp_latitude', 'gp_longitude', 'gp_photos',
      'smart_rack', 'fdms_shelf', 'ip_mpls_router',
      'sfp_10g', 'sfp_1g',
      'power_system_with_mppt', 'power_system_with_out_mppt',
      'mppt_solar_1kw', 'equipment_photo', 'electricity_meter',
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




// ✅ Get all GP Installation records (with optional filters)
async function getAllInstallations(req, res) {
  let connection;
  try {
    const { user_id, state_code, district_code, block_code, gp_code } = req.query;

    const conditions = [];
    const params = [];

    if (user_id) {
      conditions.push("user_id = ?");
      params.push(user_id);
    }
    if (state_code) {
      conditions.push("state_code = ?");
      params.push(state_code);
    }
    if (district_code) {
      conditions.push("district_code = ?");
      params.push(district_code);
    }
    if (block_code) {
      conditions.push("block_code = ?");
      params.push(block_code);
    }
    if (gp_code) {
      conditions.push("gp_code = ?");
      params.push(gp_code);
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    connection = await pool.getConnection();
    const [rows] = await connection.execute(
      `SELECT * FROM gp_installation ${whereClause} ORDER BY id DESC`,
      params
    );

    res.status(200).json({
      status: true,
      totalRows: rows.length,
      filters: { user_id, state_code, district_code, block_code, gp_code },
      data: rows
    });

  } catch (error) {
    console.error("Error fetching gp_installation data:", error);
    res.status(500).json({
      status: false,
      message: "Internal Server Error",
      error: error.message
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
      'sfp_10g', 'sfp_1g',
      'power_system_with_mppt', 'power_system_with_out_mppt',
      'mppt_solar_1kw', 'equipment_photo', 'electricity_meter',
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



module.exports = { createInstallation, getAllInstallations, updateInstallation };
