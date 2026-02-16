const pool = require("../db");

async function createJoint(req, res) {
  let connection;

  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    const {
      state_id,
      state_name,
      district_id,
      district_name,
      block_id,
      user_id,
      contractor_name,
      contractor_phone,
      proof_photo,
      block_name,
      work_type,
      joint_type,
      date_time,
      gps_lat,
      gps_long,
      address,
      photos = [],
      cables = [],
      tube_mapping = [],
      fiber_splicing = [],
    } = req.body;

    if (!cables.length) {
      return res
        .status(400)
        .json({ success: false, message: "Cable required" });
    }

    const photo_path = req.body.photo_path || null;

    /* ================= BASE CODE ================= */
    const base_code = cables
      .map(c => c.cable_id)
      .sort()
      .join("_");

    const joint_code = `${base_code}_${Date.now()}`;

    /* ================= AUTO JOINT NAME ================= */
    const [existing] = await connection.query(
      `SELECT COUNT(DISTINCT joint_code) AS total
       FROM joint_fiber_managment
       WHERE joint_code LIKE ?`,
      [`${base_code}_%`]
    );

    const nextNumber = (existing[0].total || 0) + 1;
    const joint_name = `JOINT-${String(nextNumber).padStart(3, "0")}`;

    /* ================= CABLE ================= */
    for (const c of cables) {
      await connection.query(
        `INSERT INTO joint_fiber_managment (
          state_id, state_name,
          district_id, district_name,
          block_id, block_name, user_id,
          contractor_name, contractor_phone,
          joint_code, joint_name,
          work_type, joint_type, date_time,
          gps_lat, gps_long, address, photo_path, proof_photo,
          cable_id, cable_name, from_node, to_node,
          fiber_count, cable_type,
          record_type
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, ?)`,
        [
          state_id,
          state_name,
          district_id,
          district_name,
          block_id,
          block_name,
          user_id,
          contractor_name,
          contractor_phone,
          joint_code,
          joint_name,
          work_type,
          joint_type,
          date_time,
          gps_lat,
          gps_long,
          address,
          photo_path,
           proof_photo,
          c.cable_id,
          c.cable_name,
          c.from_node,
          c.to_node,
          c.fiber_count,
          c.cable_type,
          "CABLE",
        ]
      );
    }

    /* ================= TUBE ================= */
    for (const t of tube_mapping) {
      await connection.query(
        `INSERT INTO joint_fiber_managment (
          state_id, state_name,
          district_id, district_name,
          block_id, block_name, user_id,
          contractor_name, contractor_phone
          joint_code, joint_name,
          work_type, joint_type, date_time,
          gps_lat, gps_long, address, photo_path,
          from_cable, to_cable,
          from_tube, from_tube_color,
          to_tube, to_tube_color,
          record_type
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, ?)`,
        [
          state_id,
          state_name,
          district_id,
          district_name,
          block_id,
          block_name,
          user_id,
          contractor_name,
          contractor_phone,
          joint_code,
          joint_name,
          work_type,
          joint_type,
          date_time,
          gps_lat,
          gps_long,
          address,
          photo_path,
          t.from_cable,
          t.to_cable,
          t.from_tube,
          t.from_tube_color,
          t.to_tube,
          t.to_tube_color,
          "TUBE",
        ]
      );
    }

    /* ================= FIBER ================= */
    for (const f of fiber_splicing) {
      await connection.query(
        `INSERT INTO joint_fiber_managment (
          state_id, state_name,
          district_id, district_name,
          block_id, block_name, user_id,
          contractor_name, contractor_phone,
          joint_code, joint_name,
          work_type, joint_type, date_time,
          gps_lat, gps_long, address, photo_path,
          from_cable, to_cable,
          from_tube, to_tube,
          from_core, from_rib,
          to_core, to_rib,
          splice_status,
          record_type
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          state_id,
          state_name,
          district_id,
          district_name,
          block_id,
          block_name,
          user_id,
          contractor_name,
          contractor_phone,
          joint_code,
          joint_name,
          work_type,
          joint_type,
          date_time,
          gps_lat,
          gps_long,
          address,
          photo_path,
          f.from_cable,
          f.to_cable,
          f.from_tube,
          f.to_tube,
          f.from_core,
          f.from_rib,
          f.to_core,
          f.to_rib,
          f.status,
          "FIBER",
        ]
      );
    }

    await connection.commit();

    res.json({
      success: true,
      message: "Joint created successfully",
      joint_code,
      joint_name,
    });

  } catch (err) {
    if (connection) await connection.rollback();
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (connection) connection.release();
  }
}




async function fetchJointByCode(req, res) {
  const { joint_code } = req.params;
  let connection;

  try {
    connection = await pool.getConnection();

    const [rows] = await connection.query(
      `SELECT * 
       FROM joint_fiber_managment
       WHERE joint_code = ?
       ORDER BY id ASC`,
      [joint_code]
    );

    if (!rows.length) {
      return res.status(404).json({
        success: false,
        message: "Joint not found",
      });
    }

    const base = rows[0];

    const response = {
      state_id: base.state_id,
      state_name: base.state_name,
      district_id: base.district_id,
      district_name: base.district_name,
      block_id: base.block_id,
      block_name: base.block_name,
      user_id: base.user_id,
      contractor_name: base.contractor_name,
       contractor_phone :base.contractor_phone,
      work_type: base.work_type,
      joint_type: base.joint_type,
      joint_name : base.joint_name,
      date_time: base.date_time,
      gps_lat: base.gps_lat,
      gps_long: base.gps_long,
      address: base.address,
      photo_path: base.photo_path,
      proof_photo : base.proof_photo,
      cables: [],
      tube_mapping: [],
      fiber_splicing: [],
    };

    // -------- CABLE LIST --------
    const cableRows = rows.filter((r) => r.record_type === "CABLE");

    // Make Map => { CBL-01 : "Sindrani TO FPOI-1006" }
    const cableMap = {};
    cableRows.forEach((r) => {
      cableMap[r.cable_id] = r.cable_name;
      response.cables.push({
        cable_id: r.cable_id,
        cable_name: r.cable_name,
        from_node: r.from_node,
        to_node: r.to_node,
        fiber_count: r.fiber_count,
        cable_type: r.cable_type,
      });
    });

    // -------- TUBE MAPPING --------
    rows
      .filter((r) => r.record_type === "TUBE")
      .forEach((r) => {
        response.tube_mapping.push({
          from_cable: r.from_cable,
          from_cable_name: cableMap[r.from_cable] || null,
          from_tube: r.from_tube,
          from_tube_color: r.from_tube_color,

          to_cable: r.to_cable,
          to_cable_name: cableMap[r.to_cable] || null,
          to_tube: r.to_tube,
          to_tube_color: r.to_tube_color,
        });
      });

    // -------- FIBER SPLICING --------
    rows
      .filter((r) => r.record_type === "FIBER")
      .forEach((r) => {
        response.fiber_splicing.push({
          from_cable: r.from_cable,
          from_cable_name: cableMap[r.from_cable] || null,
          to_cable: r.to_cable,
          to_cable_name: cableMap[r.to_cable] || null,

          from_tube: r.from_tube,
          to_tube: r.to_tube,
          from_core: r.from_core,
          to_core: r.to_core,
           from_rib: r.from_rib,
          to_rib  :  r.to_rib,
          status: r.splice_status,
        });
      });

    res.json(response);
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (connection) connection.release();
  }
}


async function getJointsByBlock(req, res) {
  const { state_id, district_id, block_id } = req.query;
  let connection;

  if (!state_id || !district_id || !block_id) {
    return res.status(400).json({
      success: false,
      message: "state_id, district_id and block_id are required",
    });
  }

  try {
    connection = await pool.getConnection();

    const [rows] = await connection.query(
      `SELECT 
         joint_code,
          joint_name,
         cable_id,
         cable_name
       FROM joint_fiber_managment
       WHERE state_id = ?
         AND district_id = ?
         AND block_id = ?
         AND record_type = 'CABLE'
       ORDER BY joint_code, cable_id`,
      [state_id, district_id, block_id]
    );

    if (!rows.length) {
      return res.json([]);
    }

    // ?? Group by joint_code
    const result = {};
    for (const r of rows) {
      if (!result[r.joint_code]) {
        result[r.joint_code] = {
          joint_code: r.joint_code,
           joint_name : r.joint_name,
          cables: [],
        };
      }

      result[r.joint_code].cables.push({
        cable_id: r.cable_id,
        cable_name: r.cable_name,
      });
    }

    res.json(Object.values(result));
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (connection) connection.release();
  }
}

async function fetchJointsByLocation(req, res) {
  const { state_id, district_id, block_id } = req.query;
  let connection;

  try {
    connection = await pool.getConnection();

    const [rows] = await connection.query(
      `SELECT *
       FROM joint_fiber_managment
       WHERE state_id = ? 
       AND district_id = ?
       AND block_id = ?
       ORDER BY joint_code ASC, id ASC`,
      [state_id, district_id, block_id]
    );

    if (!rows.length) {
      return res.status(404).json({
        success: false,
        message: "No joints found in this block",
      });
    }

    // Group by joint_code
    const jointsMap = {};
    rows.forEach((r) => {
      if (!jointsMap[r.joint_code]) jointsMap[r.joint_code] = [];
      jointsMap[r.joint_code].push(r);
    });

    const finalResponse = [];

    for (const joint_code in jointsMap) {
      const jointRows = jointsMap[joint_code];
      const base = jointRows[0];

      const response = {
        joint_code,
        joint_name: base.joint_name || null,
        state_id: base.state_id,
        state_name: base.state_name,
        district_id: base.district_id,
        district_name: base.district_name,
        block_id: base.block_id,
        block_name: base.block_name,
        work_type: base.work_type,
        joint_type: base.joint_type,
        date_time: base.date_time,
        gps_lat: base.gps_lat,
        gps_long: base.gps_long,
        address: base.address,
        photo_path: base.photo_path,
         proof_photo : base.proof_photo,
        cables: [],
        tube_mapping: [],
        fiber_splicing: [],
      };

      // -------- CABLE LIST --------
      const cableRows = jointRows.filter((r) => r.record_type === "CABLE");
      const cableMap = {};

      cableRows.forEach((r) => {
        cableMap[r.cable_id] = r.cable_name;

        response.cables.push({
          cable_id: r.cable_id,
          cable_name: r.cable_name,
          from_node: r.from_node,
          to_node: r.to_node,
          fiber_count: r.fiber_count,
          cable_type: r.cable_type,
        });
      });

      // -------- TUBE --------
      jointRows
        .filter((r) => r.record_type === "TUBE")
        .forEach((r) => {
          response.tube_mapping.push({
            from_cable: r.from_cable,
            from_cable_name: cableMap[r.from_cable] || null,
            from_tube: r.from_tube,
            from_tube_color: r.from_tube_color,

            to_cable: r.to_cable,
            to_cable_name: cableMap[r.to_cable] || null,
            to_tube: r.to_tube,
            to_tube_color: r.to_tube_color,
          });
        });

      // -------- FIBER --------
      jointRows
        .filter((r) => r.record_type === "FIBER")
        .forEach((r) => {
          response.fiber_splicing.push({
            from_cable: r.from_cable,
            from_cable_name: cableMap[r.from_cable] || null,

            to_cable: r.to_cable,
            to_cable_name: cableMap[r.to_cable] || null,
             from_rib: r.from_rib,
          to_rib  :  r.to_rib,
            from_tube: r.from_tube,
            to_tube: r.to_tube,
            from_core: r.from_core,
            to_core: r.to_core,
            status: r.splice_status,
          });
        });

      finalResponse.push(response);
    }

    res.json({
      success: true,
      total_joints: finalResponse.length,
      data: finalResponse,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (connection) connection.release();
  }
}

module.exports = {
  createJoint,
  fetchJointByCode,
  getJointsByBlock,
  fetchJointsByLocation,
};
