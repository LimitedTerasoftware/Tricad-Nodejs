const pool = require("../db");

// ✅ Create Block Installation
async function createBlockInstallation(req, res) {
  let connection;
  try {
    const allowedFields = [
      "user_id", "state_code", "district_code", "block_code", "block_name",
      "block_latitude", "block_longitude", "block_photos", "smart_rack",
      "fdms_shelf", "ip_mpls_router",
      "sfp_10g", "sfp_1g", "sfp_100g",
      "rfms", "equipment_photo", "block_contacts"
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

// ✅ Get All Block Installations (with filters)
async function getAllBlockInstallations(req, res) {
  let connection;
  try {
    const { user_id, state_code, district_code, block_code } = req.query;

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

    const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    connection = await pool.getConnection();
    const [rows] = await connection.execute(
      `SELECT * FROM block_installation ${whereClause} ORDER BY id DESC`,
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

// ✅ Update Block Installation
async function updateBlockInstallation(req, res) {
  let connection;
  try {
    const allowedFields = [
      "user_id", "state_code", "district_code", "block_code", "block_name", 
      "block_latitude", "block_longitude", "block_photos", "smart_rack",
      "fdms_shelf", "ip_mpls_router",
      "sfp_10g", "sfp_1g", "sfp_100g",
      "rfms", "equipment_photo", "block_contacts"
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

module.exports = {
  createBlockInstallation,
  getAllBlockInstallations,
  updateBlockInstallation
};
