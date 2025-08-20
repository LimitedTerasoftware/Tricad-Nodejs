const mysql = require('mysql2/promise');

const dbConfig = {
    host: "localhost",
    port: 3306,
    user: "keesizta_tracking",
    password: "Welcome@022",
    database: "keesizta_tracking",
    connectTimeout: 10000, // 10 seconds
    connectionLimit: 10,
    waitForConnections: true,
};

const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const SECRET_KEY = 'Y!2#n9T$v8Z@wQe6^Jp3R!fL*Gz7H@dK';

const pool = mysql.createPool(dbConfig);

async function getDepthdata(req, res) {
    let connection;
    try {
        const { start_lgd, end_lgd, eventType } = req.query;

        if (!start_lgd || !end_lgd) {
            return res.status(400).send({
                status: false,
                error: "Missing start_lgd or end_lgd in query",
            });
        }

        connection = await pool.getConnection();
        await connection.beginTransaction();

        let query = `
           SELECT 
            cf.*, 
            gps_start.name AS start_lgd_name, 
            gps_end.name AS end_lgd_name,
            hm.registration_number AS machine_registration_number
            hm.firm_name AS firm_name
        FROM construction_forms cf
        LEFT JOIN gpslist gps_start ON cf.start_lgd = gps_start.id
        LEFT JOIN gpslist gps_end ON cf.end_lgd = gps_end.id
        LEFT JOIN Hdd_machines hm ON cf.machine_id = CAST(hm.machine_id AS CHAR)
        WHERE cf.start_lgd = ? AND cf.end_lgd = ?
        `;

        const params = [start_lgd, end_lgd];

        if (eventType) {
            query += ` AND cf.eventType = ?`;
            params.push(eventType);
        }

        query += ` ORDER BY cf.created_at ASC`;

        const [rows] = await connection.query(query, params);

        await connection.commit();

        return res.status(200).send({
            status: true,
            data: rows,
        });

    } catch (error) {
        if (connection) await connection.rollback();
        console.error("Error in getDepthdata:", error);
        return res.status(500).send({
            status: false,
            error: error.message || "Internal server error",
        });
    } finally {
        if (connection) connection.release();
    }
}




async function getLatestMachineActivity(req, res) {
    let connection;
    try {
        const { state_id, district_id, block_id } = req.query;

        connection = await pool.getConnection();
        await connection.beginTransaction();

        // Get all machines and their registration_number
        const [machines] = await connection.query(`SELECT machine_id, registration_number, authorised_person FROM Hdd_machines`);

        let results = [];

        for (const machine of machines) {
            let query = `
                SELECT 
                    cf.*, 
                    gps_start.name AS start_lgd_name,
                    gps_end.name AS end_lgd_name
                FROM construction_forms cf
                LEFT JOIN gpslist gps_start ON cf.start_lgd = gps_start.id
                LEFT JOIN gpslist gps_end ON cf.end_lgd = gps_end.id
                LEFT JOIN underground_fiber_surveys ufs ON cf.survey_id = ufs.id
                WHERE cf.machine_id = ?
            `;

            let params = [machine.machine_id];

            // Add optional filters
            if (state_id) {
                query += ` AND ufs.state_id = ?`;
                params.push(state_id);
            }

            if (district_id) {
                query += ` AND ufs.district_id = ?`;
                params.push(district_id);
            }

            if (block_id) {
                query += ` AND ufs.block_id = ?`;
                params.push(block_id);
            }

            query += ` ORDER BY cf.created_at DESC LIMIT 1`;

            const [rows] = await connection.query(query, params);

            if (rows.length > 0) {
                results.push({
                    ...rows[0],
                    machine_id: machine.machine_id,
                    registration_number: machine.registration_number,
                    authorised_person: machine.authorised_person


                });
            } else {
                results.push({
                    machine_id: machine.machine_id,
                    registration_number: machine.registration_number,
                    message: 'No activity found',
                    authorised_person: machine.authorised_person
                });
            }
        }

        await connection.commit();

        return res.status(200).send({
            status: true,
            latestActivities: results
        });

    } catch (error) {
        if (connection) await connection.rollback();
        console.error("Error in getLatestMachineActivity:", error);
        return res.status(500).send({
            status: false,
            error: error.message || "Internal server error"
        });
    } finally {
        if (connection) connection.release();
    }
}



async function getDepthDataByDateAndMachine(req, res) {
    let connection;
    try {
        let { from_date, to_date, machine_id } = req.query;

        const today = new Date().toISOString().split('T')[0];
        const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

        from_date = dateRegex.test(from_date) ? from_date : today;
        to_date = dateRegex.test(to_date) ? to_date : from_date;

        const from = `${from_date} 00:00:00`;
        const to = `${to_date} 23:59:59`;

        connection = await pool.getConnection();

        let query = `SELECT
    cf.*,
    gps_start.name AS start_lgd_name,
    gps_end.name AS end_lgd_name,
    hm.registration_number AS machine_registration_number,
    hm.registration_number AS machine_registration_number,
    gps_st.st_name AS state_name,
    gps_dt.dt_name AS district_name,
    gps_blk.blk_name AS block_name
FROM construction_forms cf
LEFT JOIN gpslist gps_start ON cf.start_lgd = gps_start.id
LEFT JOIN gpslist gps_end ON cf.end_lgd = gps_end.id
LEFT JOIN Hdd_machines hm ON cf.machine_id = hm.machine_id
LEFT JOIN underground_fiber_surveys ufs ON cf.survey_id = ufs.id
LEFT JOIN gpslist gps_st ON gps_st.st_code = ufs.state_id
LEFT JOIN gpslist gps_dt ON gps_dt.dt_code = ufs.district_id
LEFT JOIN gpslist gps_blk ON gps_blk.blk_code = ufs.block_id
WHERE cf.created_at BETWEEN ? AND ?`


        const params = [from, to];

        if (machine_id) {
            query += ` AND cf.machine_id = ?`;
            params.push(machine_id);
        }

        query += ` ORDER BY cf.created_at ASC`;


        const [rows] = await connection.query(query, params);

        res.status(200).json({
            status: true,
            data: rows,
            filters: { from_date, to_date, machine_id: machine_id || 'all' }
        });
    } catch (error) {
        console.error("Error in getDepthDataByDateAndMachine:", error);
        res.status(500).json({
            status: false,
            error: error.message || "Internal server error"
        });
    } finally {
        if (connection) connection.release();
    }
}





async function createMachine(req, res) {
    let connection;
    try {
        const data = req.body;

        const {
            serial_number,
            firm_name,
            authorised_person,
            machine_make,
            capacity,
            machine_model,
            no_of_rods,
            digitrack_make,
            digitrack_model,
            truck_make,
            truck_model,
            registration_number,
            registration_valid_upto,
            driver_batch_no,
            driver_valid_upto,
            supervisor_name,
            supervisor_email,
            supervisor_phone,
            author_phone,
            status = 'active'
        } = data;

        // Basic validation
        if (!serial_number || !firm_name || !registration_number) {
            return res.status(400).send({
                status: false,
                message: "Missing required fields: serial_number, firm_name, registration_number"
            });
        }

        connection = await pool.getConnection();
        await connection.beginTransaction();

        const [result] = await connection.execute(
            `INSERT INTO Hdd_machines (
                serial_number, firm_name, authorised_person,
                machine_make, capacity, machine_model, no_of_rods,
                digitrack_make, digitrack_model,
                truck_make, truck_model,
                registration_number, registration_valid_upto,
                driver_batch_no, driver_valid_upto,
                status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                serial_number,
                firm_name || null,
                authorised_person || null,
                machine_make || null,
                capacity || null,
                machine_model || null,
                no_of_rods || null,
                digitrack_make || null,
                digitrack_model || null,
                truck_make || null,
                truck_model || null,
                registration_number,
                registration_valid_upto || null,
                driver_batch_no || null,
                driver_valid_upto || null,
                status,
                 supervisor_name || null,
                supervisor_email || null,
                supervisor_phone || null,
                author_phone || null,
            ]
        );

        await connection.commit();

        return res.status(201).send({
            status: true,
            message: "Machine created successfully",
            machine_id: result.insertId
        });

    } catch (error) {
        if (connection) await connection.rollback();
        console.error("Error in createMachine:", error);
        return res.status(500).send({
            status: false,
            error: error.message || "Internal server error"
        });
    } finally {
        if (connection) connection.release();
    }
}


async function updateMachine(req, res) {
    let connection;
    try {
        const { machine_id } = req.params;
        const data = req.body;

        if (!machine_id) {
            return res.status(400).send({
                status: false,
                message: "Missing machine_id in URL"
            });
        }

        const {
            serial_number,
            firm_name,
            authorised_person,
            machine_make,
            capacity,
            machine_model,
            no_of_rods,
            digitrack_make,
            digitrack_model,
            truck_make,
            truck_model,
            registration_number,
            registration_valid_upto,
            driver_batch_no,
            driver_valid_upto,
            status
        } = data;

        connection = await pool.getConnection();
        await connection.beginTransaction();

        const [result] = await connection.execute(
            `UPDATE Hdd_machines SET
                serial_number = ?,
                firm_name = ?,
                authorised_person = ?,
                machine_make = ?,
                capacity = ?,
                machine_model = ?,
                no_of_rods = ?,
                digitrack_make = ?,
                digitrack_model = ?,
                truck_make = ?,
                truck_model = ?,
                registration_number = ?,
                registration_valid_upto = ?,
                driver_batch_no = ?,
                driver_valid_upto = ?,
                status = ?
             WHERE machine_id = ?`,
            [
                serial_number || null,
                firm_name || null,
                authorised_person || null,
                machine_make || null,
                capacity || null,
                machine_model || null,
                no_of_rods || null,
                digitrack_make || null,
                digitrack_model || null,
                truck_make || null,
                truck_model || null,
                registration_number || null,
                registration_valid_upto || null,
                driver_batch_no || null,
                driver_valid_upto || null,
                status || 'active',
                machine_id
            ]
        );

        await connection.commit();

        return res.status(200).send({
            status: true,
            message: result.affectedRows > 0 ? "Machine updated successfully" : "No machine found with this machine_id"
        });

    } catch (error) {
        if (connection) await connection.rollback();
        console.error("Error in updateMachine:", error);
        return res.status(500).send({
            status: false,
            error: error.message || "Internal server error"
        });
    } finally {
        if (connection) connection.release();
    }
}


async function deleteMachine(req, res) {
    let connection;
    try {
        const { machine_id } = req.params;

        if (!machine_id) {
            return res.status(400).send({
                status: false,
                message: "Missing machine_id in URL"
            });
        }

        connection = await pool.getConnection();
        await connection.beginTransaction();

        const [result] = await connection.execute(
            `UPDATE Hdd_machines SET status = 'inactive' WHERE machine_id = ?`,
            [machine_id]
        );

        await connection.commit();

        return res.status(200).send({
            status: true,
            message: result.affectedRows > 0 ? "Machine marked as inactive successfully" : "No machine found with this machine_id"
        });

    } catch (error) {
        if (connection) await connection.rollback();
        console.error("Error in deleteMachine:", error);
        return res.status(500).send({
            status: false,
            error: error.message || "Internal server error"
        });
    } finally {
        if (connection) connection.release();
    }
}


async function getMachines(req, res) {
    let connection;
    try {
        connection = await pool.getConnection();

        const [rows] = await connection.execute(`
            SELECT 
                machine_id,
                serial_number,
                contractor_name,
                registration_number,
                model,
                manufacturer,
                year_of_manufacture,
                gps_tracker_id,
                status,
                assigned_project,
                created_at,
                updated_at
            FROM Hdd_machines
            ORDER BY created_at DESC
        `);

        return res.status(200).send({
            status: true,
            machines: rows
        });

    } catch (error) {
        console.error("Error in getMachines:", error);
        return res.status(500).send({
            status: false,
            error: error.message || "Internal server error"
        });
    } finally {
        if (connection) {
            connection.release();
        }
    }
}


async function createUser(req, res) {
    let connection;
    try {
        let data = req.body;
        const { company_id, username, fullname, email, contact_no, password, machine_id, registrationNumber } = data;

        connection = await pool.getConnection();
        await connection.beginTransaction();

        // 2. Create user_id (first 4 of username + last 4 of reg number)
        const userPart = username.substring(0, 4).toLowerCase().padEnd(4, 'x'); // e.g. 'john'
        const regPart = registrationNumber.slice(-4); // last 4 digits

        const user_id = `${userPart}_${regPart}`; // e.g. 'john_5678'

        // 3. Insert user
        await connection.query(
            `INSERT INTO users (user_id, company_id, username, fullname, email, contact_no, password, machine_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [user_id, company_id, username, fullname, email, contact_no, password, machine_id]
        );

        await connection.commit();

        res.status(201).send({
            status: true,
            message: "User created successfully",
            data: {
                user_id,
                company_id,
                username,
                fullname,
                email,
                contact_no,
                password,
                machine_id
            }
        });
    } catch (error) {
        if (connection) await connection.rollback();
        console.error("Error in createUser:", error);
        return res.status(500).send({
            status: false,
            error: error.message || "Internal server error"
        });
    } finally {
        if (connection) connection.release();
    }
}



async function loginUser(req, res) {
    let connection;
    try {
        const { user_id, password } = req.body;

        connection = await pool.getConnection();

        // 1. Get user by user_id
        const [rows] = await connection.query(
            'SELECT * FROM users WHERE user_id = ?',
            [user_id]
        );

        if (rows.length === 0) {
            return res.status(401).send({ status: false, message: "Invalid user_id or password" });
        }

        const user = rows[0];

        // 2. Compare password using bcrypt
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(401).send({ status: false, message: "Invalid user_id or password" });
        }

        // 3. Generate JWT token
        const token = jwt.sign(
            {
                user_id: user.user_id,
                company_id: user.company_id,
                machine_id: user.machine_id
            },
            SECRET_KEY,
            { expiresIn: '1d' }
        );

        // 4. Send response
        res.send({
            status: true,
            message: "Login successful",
            token,
            user: {
                user_id: user.user_id,
                username: user.username,
                fullname: user.fullname,
                email: user.email,
                contact_no: user.contact_no,
                company_id: user.company_id,
                machine_id: user.machine_id
            }
        });

    } catch (error) {
        console.error("Error in loginUser:", error);
        res.status(500).send({ status: false, error: error.message });
    } finally {
        if (connection) connection.release();
    }
}



async function startpointevent(req, res) {
    let connection;
    try {
        const data = req.body;
        const {
            state_id, distrct_id, block_id, gp_id,
            startPointCoordinates, startPointPhotoPaths,
            routeBelongsTo, roadType, cableLaidOn, soilType,
            executionModality, start_lgd, end_lgd,
            machine_id, eventType, survey_id
        } = data;

        // Validate event type
        if (!eventType || eventType !== 'STARTPOINT') {
            return res.status(400).json({
                status: false,
                message: "Invalid or missing eventType. Must be 'STARTPOINT'."
            });
        }

        // Validate LGDs
        if (!start_lgd || !end_lgd) {
            return res.status(400).json({
                status: false,
                message: "start_lgd and end_lgd are required to generate link_name"
            });
        }

        // Validate required fields
        if (!startPointCoordinates || startPointPhotoPaths.length === 0) {
            return res.status(400).json({
                status: false,
                message: "startPointCoordinates and image(s) are required"
            });
        }

        const link_name = `${start_lgd}_${end_lgd}`;

        // Save to DB
        connection = await pool.getConnection();
        await connection.beginTransaction();

        await connection.query(`
            INSERT INTO construction_forms (
                state_id, distrct_id, block_id, gp_id,
                link_name, startPointCoordinates, startPointPhoto,
                routeBelongsTo, roadType, cableLaidOn, soilType,
                executionModality, start_lgd, end_lgd,
                machine_id, eventType, survey_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                state_id || null,
                distrct_id || null,
                block_id || null,
                gp_id || null,
                link_name,
                startPointCoordinates,
                JSON.stringify(startPointPhotoPaths),
                routeBelongsTo || null,
                roadType || null,
                cableLaidOn || null,
                soilType || null,
                executionModality || null,
                start_lgd,
                end_lgd,
                machine_id || null,
                eventType,
                survey_id
            ]
        );

        await connection.commit();

        res.status(201).json({
            status: true,
            message: "STARTPOINT event saved successfully",
            link_name,
            photosSaved: startPointPhotoPaths
        });

    } catch (error) {
        if (connection) await connection.rollback();
        console.error("Error saving STARTPOINT event:", error);
        res.status(500).json({
            status: false,
            error: error.message
        });
    } finally {
        if (connection) connection.release();
    }
}

async function createsurvey(req, res) {
    let connection;
    try {
        const {
            user_id,
            company_id,
            state_id,
            district_id,
            block_id,
            gp_id,
            startLocation,
            endLocation,
            vehicleserialno,
            vehicle_image,
            startPointPhoto,
            startPointCoordinates
        } = req.body;

        const eventType = "STARTSURVEY";
        const surveyType = 1;

        connection = await pool.getConnection();
        await connection.beginTransaction();

        // 1️⃣ Insert into underground_fiber_surveys
        const [surveyResult] = await connection.query(`
            INSERT INTO underground_fiber_surveys (
                user_id, company_id, state_id, district_id, block_id, gp_id, startLocation, endLocation, surveyType
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            user_id,
            company_id || null,
            state_id,
            district_id,
            block_id,
            gp_id,
            startLocation || null,
            endLocation || null,
            surveyType
        ]);

        const survey_id = surveyResult.insertId;

        // 2️⃣ Insert vehicle info into construction_forms
        await connection.query(`
            INSERT INTO construction_forms (survey_id, vehicleserialno, vehicle_image, start_lgd, end_lgd, eventType, startPointPhoto, startPointCoordinates)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            survey_id,
            vehicleserialno,
            vehicle_image,
            startLocation,
            endLocation,
            eventType,
            startPointPhoto,
            startPointCoordinates
        ]);

        await connection.commit();

        res.status(201).json({
            status: true,
            message: "Survey and vehicle info saved successfully",
            survey_id,
            vehicle: {
                serial: vehicleserialno,
                image: vehicle_image
            }
        });

    } catch (error) {
        if (connection) await connection.rollback();
        console.error("Error in survey creation:", error);
        res.status(500).json({
            status: false,
            error: error.message || "Internal server error"
        });
    } finally {
        if (connection) connection.release();
    }
}


async function getFilteredSurveys(req, res) {
    let connection;
    try {
        const { state_id, district_id, block_id } = req.query;

        connection = await pool.getConnection();
        await connection.beginTransaction();

        // Start with surveyType = 1 condition
        let query = `SELECT * FROM underground_fiber_surveys WHERE surveyType = '1'`;
        let params = [];

        // Optional filters
        if (state_id) {
            query += ` AND state_id = ?`;
            params.push(state_id);
        }

        if (district_id) {
            query += ` AND district_id = ?`;
            params.push(district_id);
        }

        if (block_id) {
            query += ` AND block_id = ?`;
            params.push(block_id);
        }

        // Sort by latest created_at
        query += ` ORDER BY created_at DESC`;

        const [rows] = await connection.query(query, params);

        await connection.commit();

        return res.status(200).send({
            status: true,
            data: rows,
        });

    } catch (error) {
        if (connection) await connection.rollback();
        console.error("Error in getFilteredSurveys:", error);
        return res.status(500).send({
            status: false,
            error: error.message || "Internal server error",
        });
    } finally {
        if (connection) connection.release();
    }
}



async function createEvent(req, res) {
    let connection;
    try {
        const allowedFields = [
            'state_id', 'distrct_id', 'block_id', 'gp_id',
            'startPointPhoto', 'startPointCoordinates', 'routeBelongsTo', 'roadType',
            'cableLaidOn', 'soilType', 'crossingType', 'crossingLength', 'crossingLatlong',
            'crossingPhotos', 'executionModality', 'depthLatlong', 'depthPhoto', 'depthMeters',
            'fpoiLatLong', 'fpoiPhotos', 'jointChamberLatLong', 'jointChamberPhotos',
            'manholeLatLong', 'manholePhotos', 'routeIndicatorLatLong', 'routeIndicatorPhotos',
            'landmarkLatLong', 'landmarkPhotos', 'fiberTurnLatLong', 'fiberTurnPhotos',
            'kilometerstoneLatLong', 'kilometerstonePhotos', 'status', 'start_lgd', 'end_lgd',
            'machine_id', 'contractor_details', 'vehicleserialno', 'distance',
            'startPitLatlong', 'startPitPhotos', 'endPitLatlong', 'endPitPhotos',
            'roadWidthLatlong', 'roadWidth', 'roadWidthPhotos', 'eventType',
            'survey_id', 'vehicle_image', 'endPitDoc', 'holdLatlong', ''
        ];

        const body = req.body;
        const columns = [];
        const values = [];
        const placeholders = [];

        // Auto-generate link_name if both start_lgd and end_lgd are present
        if (body.start_lgd && body.end_lgd) {
            body.link_name = `${body.start_lgd}_${body.end_lgd}`;
        }

        for (const field of [...allowedFields, 'link_name']) {
            if (body[field] !== undefined) {
                columns.push(field);
                const value = Array.isArray(body[field])
                    ? JSON.stringify(body[field])
                    : body[field];
                values.push(value);
                placeholders.push('?');
            }
        }

        if (columns.length === 0) {
            return res.status(400).json({ status: false, message: 'No valid data provided.' });
        }

        connection = await pool.getConnection();
        await connection.beginTransaction();

        const query = `
      INSERT INTO construction_forms (${columns.join(', ')})
      VALUES (${placeholders.join(', ')})
    `;

        await connection.query(query, values);
        await connection.commit();

        res.status(201).json({
            status: true,
            message: "Construction data saved successfully",
            link_name: body.link_name || null
        });

    } catch (error) {
        if (connection) await connection.rollback();
        console.error('Error saving construction data:', error);
        res.status(500).json({
            status: false,
            error: error.message
        });
    } finally {
        if (connection) connection.release();
    }
}



async function getMachineDailyDistances(req, res) {
    let connection;
    try {
        const { machine_id, from_date, to_date } = req.query;

        if (!machine_id) {
            return res.status(400).send({ status: false, error: "Missing machine_id" });
        }

        connection = await pool.getConnection();
        await connection.beginTransaction();

        // Build SQL query
        let query = `
            SELECT depthLatlong, created_at
            FROM construction_forms
            WHERE machine_id = ?`;
        const queryParams = [machine_id];

        if (from_date && to_date) {
            query += ` AND DATE(created_at) BETWEEN ? AND ?`;
            queryParams.push(from_date, to_date);
        }

        query += ` ORDER BY created_at ASC`;

        const [rows] = await connection.query(query, queryParams);

        // Group coordinates by date
        const groupedByDate = {};
        for (const row of rows) {
            const { depthLatlong, created_at } = row;
            if (!depthLatlong || !depthLatlong.includes(',')) continue;

            const date = new Date(created_at).toISOString().split('T')[0];
            if (!groupedByDate[date]) groupedByDate[date] = [];

            groupedByDate[date].push(depthLatlong);
        }

        // Haversine formula
        const haversineDistance = (lat1, lon1, lat2, lon2) => {
            const toRad = deg => deg * Math.PI / 180;
            const R = 6371; // Earth radius in km
            const dLat = toRad(lat2 - lat1);
            const dLon = toRad(lon2 - lon1);
            const a = Math.sin(dLat / 2) ** 2 +
                      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
                      Math.sin(dLon / 2) ** 2;
            const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
            return R * c;
        };

        // Calculate distance per day
        const result = [];
        for (const date in groupedByDate) {
            const coords = groupedByDate[date];
            let totalDistance = 0;

            for (let i = 0; i < coords.length - 1; i++) {
                try {
                    const [lat1, lon1] = coords[i].split(',').map(Number);
                    const [lat2, lon2] = coords[i + 1].split(',').map(Number);

                    if ([lat1, lon1, lat2, lon2].some(isNaN)) continue;

                    totalDistance += haversineDistance(lat1, lon1, lat2, lon2);
                } catch (err) {
                    console.warn("Skipping invalid coordinate pair:", coords[i], coords[i + 1]);
                    continue;
                }
            }

            result.push({ date, totalDistance: totalDistance.toFixed(2) + ' km' });
        }

        await connection.commit();
        res.status(200).json({ status: true, data: result });

    } catch (error) {
        if (connection) await connection.rollback();
        console.error("Error in getMachineDailyDistances:", error);
        res.status(500).json({ status: false, error: error.message });
    } finally {
        if (connection) connection.release();
    }
}




// Utility to calculate distance between two lat-long points



async function editImages(req, res) {
    let connection;
    try {
        const { id, ...updateFields } = req.body;

        if (!id || Object.keys(updateFields).length === 0) {
            return res.status(400).json({
                status: false,
                error: "Missing id or fields to update"
            });
        }

        connection = await pool.getConnection();
        await connection.beginTransaction();

        const setClause = Object.keys(updateFields)
            .map(key => `${key} = ?`)
            .join(', ');
        const values = Object.values(updateFields);

        const query = `UPDATE construction_forms SET ${setClause} WHERE id = ?`;
        values.push(id); // add id at the end

        await connection.query(query, values);
        await connection.commit();

        return res.status(200).json({
            status: true,
            message: "Fields updated successfully"
        });
    } catch (error) {
        if (connection) await connection.rollback();
        console.error("Error in editImages:", error);
        res.status(500).json({ status: false, error: error.message });
    } finally {
        if (connection) connection.release();
    }
}


//----------------------edit physical survey image--------------------------------------

async function editphysicalsurvey(req, res) {
    let connection;
    try {
        const { id, ...updateFields } = req.body;

        if (!id || Object.keys(updateFields).length === 0) {
            return res.status(400).json({
                status: false,
                error: "Missing id or fields to update"
            });
        }

        connection = await pool.getConnection();
        await connection.beginTransaction();

        // These are fields in your table that need to be stored as JSON (longtext)
        const jsonFields = [
            "patroller_details",
            "road_crossing",
            "route_details",
            "route_feasibility",
            "videoDetails",
            "utility_features_checked",
            "start_photos",
            "end_photos"
        ];

        for (const key of jsonFields) {
            if (updateFields[key] && typeof updateFields[key] !== 'string') {
                updateFields[key] = JSON.stringify(updateFields[key]);
            }
        }

        const setClause = Object.keys(updateFields)
            .map(key => `${key} = ?`)
            .join(', ');
        const values = Object.values(updateFields);
        values.push(id); // Add `id` for WHERE clause

        const query = `UPDATE underground_survey_data SET ${setClause} WHERE id = ?`;
        await connection.query(query, values);
        await connection.commit();

        return res.status(200).json({
            status: true,
            message: "Survey data updated successfully"
        });

    } catch (error) {
        if (connection) await connection.rollback();
        console.error("Error in editSurveyData:", error);
        res.status(500).json({ status: false, error: error.message });
    } finally {
        if (connection) connection.release();
    }
}



async function getSurveyHistoryByUser(req, res) {
    let connection;
    try {
        const { user_id } = req.query;

        if (!user_id) {
            return res.status(400).json({
                status: false,
                error: "Missing user_id in query"
            });
        }

        connection = await pool.getConnection();

        const query = `
            SELECT
                ufs.*,
                gps_start.name AS start_lgd_name,
                gps_end.name AS end_lgd_name,
                gps_start.st_name AS state_name,
                gps_start.dt_name AS district_name,
                gps_start.blk_name AS block_name,
                users.fullname AS user_name,
                users.contact_no AS user_mobile,
                CASE
                    WHEN cf_latest.eventType = 'ENDSURVEY' THEN 'COMPLETED'
                    ELSE 'HOLD'
                END AS survey_status
            FROM underground_fiber_surveys ufs
            LEFT JOIN gpslist gps_start ON ufs.startLocation = gps_start.id
            LEFT JOIN gpslist gps_end ON ufs.endLocation = gps_end.id
            LEFT JOIN users ON ufs.user_id = users.id
            LEFT JOIN (
                SELECT cf1.survey_id, cf1.eventType
                FROM construction_forms cf1
                INNER JOIN (
                    SELECT survey_id, MAX(created_at) AS max_time
                    FROM construction_forms
                    GROUP BY survey_id
                ) cf2
                ON cf1.survey_id = cf2.survey_id AND cf1.created_at = cf2.max_time
            ) cf_latest ON cf_latest.survey_id = ufs.id
            WHERE ufs.user_id = ? AND ufs.surveyType = '1'
            ORDER BY ufs.created_at DESC
        `;

        const [rows] = await connection.query(query, [user_id]);

        return res.status(200).json({
            status: true,
            history: rows
        });

    } catch (error) {
        console.error("Error in getSurveyHistoryByUser:", error);
        res.status(500).json({
            status: false,
            error: error.message || "Internal server error"
        });
    } finally {
        if (connection) connection.release();
    }
}







const haversineDistance = (lat1, lon1, lat2, lon2) => {
  const toRad = (val) => (val * Math.PI) / 180;
  const R = 6371; // Earth radius in KM
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) ** 2;

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c; // in KM
};

async function getMachineMonthlyAmount(req, res) {
    let connection;
    try {
        const { machine_id, month, year } = req.query;

        const today = new Date();
        const defaultYear = today.getFullYear();
        const defaultMonth = today.getMonth() + 1;
        const defaultDate = today.toISOString().split('T')[0];

        const validatedMonth = month && !isNaN(month) && month >= 1 && month <= 12 ? parseInt(month) : defaultMonth;
        const validatedYear = year && !isNaN(year) && year >= 2000 ? parseInt(year) : defaultYear;

        const from = `${validatedYear}-${validatedMonth.toString().padStart(2, '0')}-01 00:00:00`;
        const lastDay = new Date(validatedYear, validatedMonth, 0).getDate();
        const to = `${validatedYear}-${validatedMonth.toString().padStart(2, '0')}-${lastDay} 23:59:59`;

        connection = await pool.getConnection();

        const queryParams = [from, to];
        let query = `
            SELECT machine_id, depthLatlong, depthMeters, eventType, created_at, id
            FROM construction_forms
            WHERE created_at BETWEEN ? AND ?
        `;

        if (machine_id && machine_id.trim()) {
            query += ` AND machine_id = ?`;
            queryParams.push(machine_id.trim());
        }

        query += ` ORDER BY machine_id, created_at ASC`;

        const [rows] = await connection.query(query, queryParams);

        const groupedByMachineAndDate = {};
        const seenCoords = new Set();
        const depthDetails = {
            totalDepthEvents: 0,
            penalty500: 0,
            penalty1100: 0,
            alerts: 0,
            totalDepthPenalty: 0,
            details: []
        };

        for (const row of rows) {
            const { machine_id, depthLatlong, created_at, depthMeters, eventType, id } = row;
            if (!depthLatlong || !depthLatlong.includes(',')) continue;

            // === DISTANCE GROUPING ===
            const date = new Date(created_at).toISOString().split('T')[0];
            const key = `${machine_id}-${date}-${depthLatlong}`;
            if (seenCoords.has(key)) continue;
            seenCoords.add(key);

            if (!groupedByMachineAndDate[machine_id]) groupedByMachineAndDate[machine_id] = {};
            if (!groupedByMachineAndDate[machine_id][date]) groupedByMachineAndDate[machine_id][date] = [];
            groupedByMachineAndDate[machine_id][date].push(depthLatlong);

            // === DEPTH PENALTIES ===
            if (!depthMeters || isNaN(depthMeters)) continue;
             const depth = parseFloat(depthMeters) * 100; 

            const event = {
                id,
                depth,
                latlong: depthLatlong,
                eventType,
                created_at
            };

            if (depth >= 150 && depth <= 164) {
                depthDetails.penalty500 += 1;
                depthDetails.totalDepthPenalty += 500;
                depthDetails.details.push({ ...event, penalty: 500 });
            } else if (depth >= 120 && depth < 150) {
                depthDetails.penalty1100 += 1;
                depthDetails.totalDepthPenalty += 1100;
                depthDetails.details.push({ ...event, penalty: 1100 });
            } else if (depth < 120) {
                depthDetails.alerts += 1;
                depthDetails.details.push({ ...event, alert: true });
            }
        }

        // === DISTANCE CALCULATION ===
        const haversineDistance = (lat1, lon1, lat2, lon2) => {
            const toRad = deg => deg * Math.PI / 180;
            const R = 6371;
            const dLat = toRad(lat2 - lat1);
            const dLon = toRad(lon2 - lon1);
            const a = Math.sin(dLat / 2) ** 2 +
                Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
                Math.sin(dLon / 2) ** 2;
            const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
            return R * c;
        };

        const machineResults = [];

        for (const machineId in groupedByMachineAndDate) {
            const dailyDistances = [];
            let monthlyTotalDistance = 0;

            for (const date in groupedByMachineAndDate[machineId]) {
                const coords = groupedByMachineAndDate[machineId][date];
                let dailyDistance = 0;

                for (let i = 0; i < coords.length - 1; i++) {
                    try {
                        const [lat1, lon1] = coords[i].split(',').map(Number);
                        const [lat2, lon2] = coords[i + 1].split(',').map(Number);
                        if ([lat1, lon1, lat2, lon2].some(isNaN)) continue;
                        dailyDistance += haversineDistance(lat1, lon1, lat2, lon2);
                    } catch (err) {
                        continue;
                    }
                }

                dailyDistance = parseFloat(dailyDistance.toFixed(2));
                monthlyTotalDistance += dailyDistance;

                const dailyBaseline = 0.25;
                const difference = parseFloat((dailyDistance - dailyBaseline).toFixed(2));

                dailyDistances.push({
                    date,
                    totalDistance: dailyDistance,
                    meetsDailyRequirement: dailyDistance >= dailyBaseline,
                    difference
                });
            }

            const monthlyBaseline = 7.5;
            const segmentSize = 0.25;
            const machineRent = 1125000;
            let monthlyPenalty = 0, monthlyIncentive = 0;
            let netCost = machineRent;

            if (monthlyTotalDistance < monthlyBaseline) {
                const shortfall = monthlyBaseline - monthlyTotalDistance;
                const segments = (shortfall / segmentSize);
                monthlyPenalty = (monthlyTotalDistance < 5) ? segments * 42000 : segments * 40000;
            } else if (monthlyTotalDistance > monthlyBaseline) {
                const excess = monthlyTotalDistance - monthlyBaseline;
                const segments = (excess / segmentSize);
                monthlyIncentive = (monthlyTotalDistance <= 10) ? segments * 42000 : segments * 45000;
            }

            netCost = machineRent - monthlyPenalty + monthlyIncentive;

            machineResults.push({
                machineId,
                dailyDistances,
                monthlyTotalDistance: parseFloat(monthlyTotalDistance.toFixed(2)),
                machineRent,
                monthlyPenalty: monthlyPenalty > 0 ? monthlyPenalty : null,
                monthlyIncentive: monthlyIncentive > 0 ? monthlyIncentive : null,
                netCost: (netCost)
            });
        }

        res.status(200).json({
            status: true,
            data: machineResults,
            depthPenalties: depthDetails,
            filters: {
                machine_id: machine_id ? machine_id.trim() : null,
                month: validatedMonth,
                year: validatedYear,
                from_date: `${validatedYear}-${validatedMonth.toString().padStart(2, '0')}-01`,
                to_date: `${validatedYear}-${validatedMonth.toString().padStart(2, '0')}-${lastDay}`,
                query_date: defaultDate
            }
        });
    } catch (error) {
        console.error("Error in getMachineMonthlyAmount:", error);
        res.status(500).json({
            status: false,
            error: error.message || "Internal server error"
        });
    } finally {
        if (connection) connection.release();
    }
}

async function getAllFirmNames(req, res) {
    let connection;
    try {
        connection = await pool.getConnection();
        const [rows] = await connection.query(`
            SELECT DISTINCT firm_name 
            FROM Hdd_machines 
            WHERE firm_name IS NOT NULL AND firm_name != ''
        `);
        res.status(200).json({ status: true, data: rows });
    } catch (error) {
        res.status(500).json({ status: false, error: error.message });
    } finally {
        if (connection) connection.release();
    }
}


async function getMachinesByFirm(req, res) {
    let connection;
    try {
        const { firm_name } = req.query;

        if (!firm_name) {
            return res.status(400).json({ status: false, error: "Missing firm_name" });
        }

        connection = await pool.getConnection();
        const [rows] = await connection.query(
            `SELECT * FROM Hdd_machines WHERE firm_name = ?`, 
            [firm_name]
        );

        res.status(200).json({ status: true, data: rows });
    } catch (error) {
        res.status(500).json({ status: false, error: error.message });
    } finally {
        if (connection) connection.release();
    }
}


module.exports = { getDepthdata, getDepthDataByDateAndMachine, createMachine, getMachines, createUser, loginUser, startpointevent, createsurvey, createEvent, getLatestMachineActivity, getFilteredSurveys, updateMachine, deleteMachine, getMachineDailyDistances, editImages, getSurveyHistoryByUser, getMachineMonthlyAmount, editphysicalsurvey, getAllFirmNames, getMachinesByFirm };




// {
//                 "id": 318831,
//                 "survey_id": "2051",
//                 "area_type": "POPULATED",
//                 "event_type": "VIDEORECORD",
//                 "surveyUploaded": "true",
//                 "fpoiUrl": "",
//                 "execution_modality": "NONE",
//                 "latitude": "17.4296097",
//                 "longitude": "78.4070147",
//                 "altitude": "517.7000122070312",
//                 "accuracy": "7.107",
//                 "depth": "0",
//                 "distance_error": "0",
//                 "patroller_details": {
//                     "companyName": "",
//                     "email": "",
//                     "mobile": "",
//                     "name": ""
//                 },
//                 "road_crossing": {
//                     "endPhoto": "",
//                     "endPhotoLat": 0,
//                     "endPhotoLong": 0,
//                     "length": "",
//                     "roadCrossing": "NONE",
//                     "startPhoto": "",
//                     "startPhotoLat": 0,
//                     "startPhotoLong": 0
//                 },
//                 "route_details": {
//                     "centerToMargin": "2",
//                     "roadWidth": "10",
//                     "routeBelongsTo": "OTHERROADS",
//                     "routeType": "THARROAD",
//                     "soilType": "NORMAL"
//                 },
//                 "route_feasibility": {
//                     "alternatePathAvailable": false,
//                     "alternativePathDetails": "",
//                     "routeFeasible": true
//                 },
//                 "routeIndicatorUrl": null,
//                 "routeIndicatorType": "NONE",
//                 "kmtStoneUrl": null,
//                 "fiberTurnUrl": null,
//                 "landMarkType": "NONE",
//                 "landMarkUrls": null,
//                 "side_type": "NONE",
//                 "start_photos": [],
//                 "end_photos": [],
//                 "utility_features_checked": {
//                     "localInfo": "",
//                     "selectedGroundFeatures": []
//                 },
//                 "videoUrl": null,
//                 "videoDetails": {
//                     "endLatitude": 17.4296097,
//                     "endLongitude": 78.4070147,
//                     "endTimeStamp": 1753079588323,
//                     "startLatitude": 17.4303997,
//                     "startLongitude": 78.4062639,
//                     "startTimeStamp": 1753079053913,
//                     "videoUrl": "uploads\/videos\/UG_2051_1753082415_687dea2f3a42a.mp4"
//                 },
//                 "jointChamberUrl": "",
//                 "createdTime": "2025-07-21 12:03:08",
//                 "created_at": "2025-07-21 07:27:31",
//                 "updated_at": "2025-07-21 07:27:31",
//                 "routeIndicatorUrl_backup": null
//             },
//2051

