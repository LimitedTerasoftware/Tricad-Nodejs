const mysql = require('mysql2/promise');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { DOMParser } = require('xmldom');
const AdmZip = require('adm-zip');
const shpwrite = require('shp-write');



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

async function getSurveysByLocation(req, res) {
    let connection;
    try {
        const { state_id, district_id, block_id } = req.query;

        if (!state_id || !district_id || !block_id) {
            return res.status(400).json({
                status: false,
                error: "Missing required parameters: state_id, district_id, or block_id"
            });
        }

        // Convert block_id to array if it's a comma-separated string
        const blockIds = Array.isArray(block_id)
            ? block_id.map(id => parseInt(id))
            : block_id.split(',').map(id => parseInt(id.trim())).filter(Boolean);

        if (blockIds.length === 0 || blockIds.length > 10) {
            return res.status(400).json({
                status: false,
                error: "You must provide between 1 and 10 block IDs"
            });
        }

        connection = await pool.getConnection();

        const placeholders = blockIds.map(() => '?').join(', ');

        const query = `
    SELECT 
        usd.*, -- all underground_survey_data fields
        ufs.state_id,
        ufs.district_id,
        ufs.block_id,
        ufs.startLocation,
        ufs.endLocation,
        gps_start.name AS start_lgd_name,
        gps_end.name AS end_lgd_name,
        gps_start.st_name AS state_name,
        gps_start.dt_name AS district_name,
        gps_start.blk_name AS block_name
    FROM underground_fiber_surveys ufs
    INNER JOIN underground_survey_data usd 
        ON ufs.id = CAST(usd.survey_id AS UNSIGNED)
    LEFT JOIN gpslist gps_start 
        ON ufs.startLocation = gps_start.id
    LEFT JOIN gpslist gps_end 
        ON ufs.endLocation = gps_end.id
    WHERE ufs.state_id = ? 
      AND ufs.district_id = ? 
      AND ufs.block_id IN (${placeholders});
`;


        const [rows] = await connection.query(query, [state_id, district_id, ...blockIds]);

        // Group data by block_id
        const groupedData = {};
        for (const row of rows) {
            const { block_id, latitude, longitude, event_type } = row;
            if (!groupedData[block_id]) {
                groupedData[block_id] = [];
            }
            groupedData[block_id].push(row);

        }

        return res.status(200).json({
            status: true,
            data: groupedData
        });

    } catch (error) {
        console.error("Error in getSurveysByLocation:", error);
        return res.status(500).json({
            status: false,
            error: error.message
        });
    } finally {
        if (connection) connection.release();
    }
}

async function getdesktopPlanning(req, res) {
    let connection;
    try {
        const { stateId, districtId, blockId } = req.body;

        if (!stateId || !districtId || !blockId) {
            return res.status(400).json({
                status: false,
                message: "stateId, districtId and blockId are required"
            });
        }

        connection = await pool.getConnection();

        // 1️⃣ Get all networks for given state/district/block
        const [networks] = await connection.query(
            `SELECT * FROM networks 
             WHERE st_code = ? AND dt_code = ? AND blk_code = ?`,
            [stateId, districtId, blockId]
        );

        // 2️⃣ For each network, get points + connections
        const results = [];
        for (const net of networks) {
            const [points] = await connection.query(
                `SELECT * FROM points WHERE network_id = ?`,
                [net.id]
            );

            const [connections] = await connection.query(
                `SELECT * FROM connections WHERE network_id = ?`,
                [net.id]
            );

            results.push({
                ...net,
                points,
                connections
            });
        }

        res.json({
            status: true,
            data: results
        });

    } catch (error) {
        console.error("Error in getdesktopPlanning:", error);
        return res.status(500).json({
            status: false,
            error: error.message
        });
    } finally {
        if (connection) connection.release();
    }
}




async function uploadExternalData(req, res) {
    let connection;
    try {
        if (!req.files || (!req.files.desktop_planning && !req.files.physical_survey)) {
            return res.status(400).json({ error: 'At least one file (desktop_planning or physical_survey) must be uploaded' });
        }

        const { state_code, dtcode, block_code, FileName } = req.body;
        if (!state_code || !dtcode || !block_code) {
            // Delete uploaded files if validation fails
            if (req.files.desktop_planning) fs.unlinkSync(req.files.desktop_planning[0].path);
            if (req.files.physical_survey) fs.unlinkSync(req.files.physical_survey[0].path);
            return res.status(400).json({ error: 'Missing required fields: state_code, dtcode, block_code' });
        }

        const filesToSave = [];
        if (req.files.desktop_planning) {
            const file = req.files.desktop_planning[0];
            const ext = path.extname(file.originalname).toLowerCase();
            filesToSave.push({
                originalFilename: file.originalname,
                fileType: ext === '.kml' ? 'KML' : 'KMZ',
                filepath: path.join(file.destination, file.filename).replace(/\\/g, '/')
            });
        }
        if (req.files.physical_survey) {
            const file = req.files.physical_survey[0];
            const ext = path.extname(file.originalname).toLowerCase();
            filesToSave.push({
                originalFilename: file.originalname,
                fileType: ext === '.kml' ? 'KML' : 'KMZ',
                filepath: path.join(file.destination, file.filename).replace(/\\/g, '/')
            });
        }

        // Get database connection and start transaction
        connection = await pool.getConnection();
        await connection.beginTransaction();

        const query = `
            INSERT INTO external_data (state_code, dist_code, blk_code, filename, file_type, filepath, data_id)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `;
        const results = [];
        let dataid = Math.floor(Math.random() * 900) + 100;
        for (const file of filesToSave) {
            // Use connection.execute for database insertion
            await connection.execute(
                query,
                [state_code, dtcode, block_code, FileName, file.fileType, file.filepath, dataid]
            );
            results.push({
                state_code,
                dtcode,
                block_code,
                filename: FileName,
                file_type: file.fileType,
                filepath: file.filepath,
                data_id: dataid
            });
        }

        // Commit transaction
        await connection.commit();

        res.status(201).json({
            message: 'Files uploaded successfully',
            data: results
        });
    } catch (err) {
        console.error(err);
        if (connection) {
            await connection.rollback(); // Roll back transaction on error
        }
        // Clean up uploaded files on error
        if (req.files.desktop_planning) fs.unlinkSync(req.files.desktop_planning[0].path);
        if (req.files.physical_survey) fs.unlinkSync(req.files.physical_survey[0].path);
        res.status(500).json({ error: 'Server error', code: 'SERVER_ERROR' });
    } finally {
        if (connection) {
            connection.release(); // Release connection back to pool
        }
    }
};



async function getEXternalfiles(req, res) {
    let connection;
    try {
        const { state_code, dtcode, block_code, filename } = req.query;

        let query = 'SELECT id,state_code, dist_code, blk_code, filename, file_type, filepath, data_id, uploaded_at FROM external_data WHERE 1=1';
        const params = [];

        if (state_code) {
            query += ' AND state_code = ?';
            params.push(state_code.toUpperCase());
        }
        if (state_code && dtcode) {
            query += ' AND dist_code = ?';
            params.push(dtcode.toUpperCase());
        }
        if (dtcode && block_code) {
            query += ' AND blk_code = ?';
            params.push(block_code.toUpperCase());
        } else if (block_code && !dtcode) {
            return res.status(400).json({ error: 'block_code filter requires dtcode' });
        }

        if (filename) {
            query += ' AND filename LIKE ?';
            params.push(`%${filename}%`);
        }

        connection = await pool.getConnection();

        const [rows] = await connection.execute(query, params);
        const groupedByDataId = rows.reduce((acc, row) => {
            const rowWithUrl = {
                ...row,
                file_url: `/Uploads/${row.filepath}`
            };
            const existingGroup = acc.find(group => group[0]?.data_id === row.data_id);
            if (existingGroup) {
                existingGroup.push(rowWithUrl);
            } else {
                acc.push([rowWithUrl]);
            }
            return acc;
        }, []);

        res.json({
            message: 'Files retrieved successfully',
            data: groupedByDataId
        });
    } catch (err) {
        console.error('Error:', err);
        if (err.message.includes("Table 'external_data' does not exist")) {
            res.status(500).json({ error: 'Table external_data not found', code: 'TABLE_NOT_FOUND' });
        } else {
            res.status(500).json({ error: 'Server error', code: 'SERVER_ERROR' });
        }
    } finally {
        if (connection) {
            connection.release();
        }
    }
};


async function previewfile(req, res) {
    //let connection;
    try {
        const { filepath, fileType } = req.query;

        if (!filepath) {
            return res.status(400).json({ error: 'filepath query parameter is required' });
        }

        //connection = await pool.getConnection();

        // Check if file exists on filesystem
        const fullPath = path.join(__dirname, filepath);
        console.log(fullPath);

        let parsedData = { points: [], cables: [], polylines: [], styles: [] };
        let summary = { points: 0, cables: 0, polylines: 0, styles: 0 };
        const parseKML = async (content) => {
            const parser = new xml2js.Parser({ explicitArray: false });
            const result = await parser.parseStringPromise(content);

            // Extract KML Document
            const kmlDoc = result.kml?.Document;
            if (!kmlDoc) {
                throw new Error('Invalid KML structure');
            }

            // Extract styles
            if (kmlDoc.Style) {
                const styleArray = Array.isArray(kmlDoc.Style) ? kmlDoc.Style : [kmlDoc.Style];
                for (const style of styleArray) {
                    parsedData.styles.push({
                        id: style['$']?.id || null,
                        lineStyle: style.LineStyle ? {
                            color: style.LineStyle.color || null,
                            width: style.LineStyle.width || null
                        } : null,
                        iconStyle: style.IconStyle ? {
                            iconUrl: style.IconStyle.Icon?.href || null
                        } : null,
                        polyStyle: style.PolyStyle ? {
                            color: style.PolyStyle.color || null,
                            fill: style.PolyStyle.fill || null
                        } : null
                    });
                }
                summary.styles = parsedData.styles.length;
            }

            // Extract placemarks (points, cables, polylines)
            if (kmlDoc.Placemark) {
                const placemarkArray = Array.isArray(kmlDoc.Placemark) ? kmlDoc.Placemark : [kmlDoc.Placemark];
                for (const placemark of placemarkArray) {
                    const name = placemark.name || 'Unnamed';
                    const styleUrl = placemark.styleUrl || null;

                    // Handle Point geometry
                    if (placemark.Point) {
                        const coordinates = placemark.Point.coordinates?.trim().split(',').map(Number) || [];
                        if (coordinates.length >= 2) {
                            parsedData.points.push({
                                name,
                                styleUrl,
                                coordinates: {
                                    longitude: coordinates[0],
                                    latitude: coordinates[1]
                                }
                            });
                        }
                    }

                    // Handle LineString geometry
                    if (placemark.LineString) {
                        const coordinates = placemark.LineString.coordinates?.trim().split(/\s+/).map(coord => {
                            const [longitude, latitude] = coord.split(',').map(Number);
                            return [longitude, latitude];
                        }) || [];
                        const distance = placemark.description?.match(/(\d+\.?\d*)\s*km/)?.[1] || null;
                        const isExisting = placemark.description?.includes('true') || false;

                        const lineData = {
                            name,
                            styleUrl,
                            distance: distance ? parseFloat(distance) : null,
                            coordinates
                        };
                        parsedData.polylines.push(lineData);

                    }
                }
                summary.points = parsedData.points.length;
                summary.cables = parsedData.cables.length;
                summary.polylines = parsedData.polylines.length;
            }
        };

        if (fileType === 'KML') {
            const fileContent = fs.readFileSync(fullPath, 'utf-8');
            await parseKML(fileContent);
        } else if (fileType === 'KMZ') {
            const buffer = fs.readFileSync(fullPath);
            const parsedResult = parseKmz(buffer);

            // Map to your desired format
            parsedData.points = parsedResult.points.map(p => ({
                name: p.name,
                coordinates: {
                    longitude: p.coordinates[0],
                    latitude: p.coordinates[1]
                },
                type: p.type ? p.type : "point"

            }));

            //---------polylines---------------------------------------

            parsedData.polylines = parsedResult.lines.map(line => ({
                name: line.name,
                type: line.type, // <-- Include type: "Proposed Cable" or "Incremental Cable"
                styleUrl: null,
                distance: line.length ? parseFloat(line.length) : null,
                coordinates: line.coordinates
            }));

            summary.points = parsedData.points.length;
            summary.polylines = parsedData.polylines.length;

        } else {
            return res.status(400).json({ error: 'Unsupported file type', code: 'INVALID_FILE_TYPE' });
        }

        res.json({
            message: 'File parsed successfully',
            data: {
                filepath,
                file_type: fileType,
                summary,
                parsed_data: parsedData
            }
        });

    } catch (err) {
        console.error('Error:', err);
        if (err.message.includes("Table 'external_data' does not exist")) {
            res.status(500).json({ error: 'Table external_data not found', code: 'TABLE_NOT_FOUND' });
        } else if (err.message.includes('Invalid KML') || err.message.includes('Invalid KMZ')) {
            res.status(400).json({ error: 'Failed to parse file', code: 'PARSE_ERROR' });
        } else {
            res.status(500).json({ error: 'Server error', code: 'SERVER_ERROR' });
        }
    } finally {
        // if (connection) {
        //     connection.release();
        // }
    }
}


async function insertFpoi(req, res) {
    let connection;
    try {
        // Destructure fields from request body
        const {
            name,
            lattitude,
            longitude,
            type,
            blk_code,
            blk_name,
            dt_code,
            dt_name,
            st_code,
            st_name,
            lgd_code,
            remark
        } = req.body;

        // Validate required fields if needed
        if (!name || !lattitude || !longitude || !type) {
            return res.status(400).send({ status: false, message: "Missing required fields." });
        }

        // Get DB connection
        connection = await pool.getConnection(); // Replace with your DB connection function

        const insertQuery = `
            INSERT INTO gpslist (
                name, lattitude, longitude, type,
                blk_code, blk_name, dt_code, dt_name,
                st_code, st_name, lgd_code, remark
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;

        const [result] = await connection.execute(insertQuery, [
            name, lattitude, longitude, type,
            blk_code, blk_name, dt_code, dt_name,
            st_code, st_name, lgd_code, remark
        ]);

        return res.status(201).send({
            status: true,
            message: "FPOI inserted successfully",
            insertedId: result.insertId
        });

    } catch (error) {
        console.error("Error inserting FPOI:", error);
        return res.status(500).send({
            status: false,
            message: "Internal Server Error",
            error: error.message
        });
    } finally {
        if (connection) connection.release?.(); // or connection.end() if not using a pool
    }
}



async function getGpsListPaginated(req, res) {
    let connection;
    try {
        // Get pagination details
        const page = parseInt(req.query.page) || 1;
        const limit = 15;
        const offset = (page - 1) * limit;

        // Get optional filters
        const { st_code, dt_code, blk_code, type } = req.query;

        const conditions = [];
        const params = [];

        if (st_code) {
            conditions.push("st_code = ?");
            params.push(st_code);
        }
        if (dt_code) {
            conditions.push("dt_code = ?");
            params.push(dt_code);
        }
        if (blk_code) {
            conditions.push("blk_code = ?");
            params.push(blk_code);
        }
        if (type) {
            conditions.push("type = ?");
            params.push(type);
        }

        const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

        connection = await pool.getConnection();

        // Count with filters
        const [countResult] = await connection.execute(
            `SELECT COUNT(*) AS total FROM gpslist ${whereClause}`,
            params
        );
        const totalRows = countResult[0].total;
        const totalPages = Math.ceil(totalRows / limit);

        // Fetch paginated data with filters
        const [rows] = await connection.execute(
            `SELECT * FROM gpslist ${whereClause} ORDER BY id DESC LIMIT ? OFFSET ?`,
            [...params, limit, offset]
        );

        return res.status(200).send({
            status: true,
            currentPage: page,
            totalPages,
            totalRows,
            filters: { st_code, dt_code, blk_code, type },
            data: rows
        });

    } catch (error) {
        console.error("Error fetching paginated GPS list:", error);
        return res.status(500).send({
            status: false,
            message: "Internal Server Error",
            error: error.message
        });
    } finally {
        if (connection) connection.release?.();
    }
}


async function getGpsListPaginated(req, res) {
    let connection;
    try {
        // Get pagination details
        const page = parseInt(req.query.page) || 1;
        const limit = 15;
        const offset = (page - 1) * limit;

        // Get optional filters
        const { st_code, dt_code, blk_code, type } = req.query;

        const conditions = [];
        const params = [];

        if (st_code) {
            conditions.push("st_code = ?");
            params.push(st_code);
        }
        if (dt_code) {
            conditions.push("dt_code = ?");
            params.push(dt_code);
        }
        if (blk_code) {
            conditions.push("blk_code = ?");
            params.push(blk_code);
        }
        if (type) {
            conditions.push("type = ?");
            params.push(type);
        }

        const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

        connection = await pool.getConnection();

        // Count with filters
        const [countResult] = await connection.execute(
            `SELECT COUNT(*) AS total FROM gpslist ${whereClause}`,
            params
        );
        const totalRows = countResult[0].total;
        const totalPages = Math.ceil(totalRows / limit);

        // Fetch paginated data with filters
        const [rows] = await connection.execute(
            `SELECT * FROM gpslist ${whereClause} ORDER BY id DESC LIMIT ? OFFSET ?`,
            [...params, limit, offset]
        );

        return res.status(200).send({
            status: true,
            currentPage: page,
            totalPages,
            totalRows,
            filters: { st_code, dt_code, blk_code, type },
            data: rows
        });

    } catch (error) {
        console.error("Error fetching paginated GPS list:", error);
        return res.status(500).send({
            status: false,
            message: "Internal Server Error",
            error: error.message
        });
    } finally {
        if (connection) connection.release?.();
    }
}



async function filterGpsList(req, res) {
    let connection;
    try {
        const { st_code, dt_code, blk_code } = req.query;

        // Build dynamic WHERE clause
        const conditions = [];
        const params = [];

        if (st_code) {
            conditions.push("st_code = ?");
            params.push(st_code);
        }

        if (dt_code) {
            conditions.push("dt_code = ?");
            params.push(dt_code);
        }

        if (blk_code) {
            conditions.push("blk_code = ?");
            params.push(blk_code);
        }

        const whereClause = conditions.length > 0 ? "WHERE " + conditions.join(" AND ") : "";

        connection = await pool.getConnection();

        const [rows] = await connection.execute(
            `SELECT * FROM gpslist ${whereClause} ORDER BY id DESC`,
            params
        );

        return res.status(200).send({
            status: true,
            total: rows.length,
            data: rows
        });

    } catch (error) {
        console.error("Error filtering GPS list:", error);
        return res.status(500).send({
            status: false,
            message: "Internal Server Error",
            error: error.message
        });
    } finally {
        if (connection) connection.release?.();
    }
}


async function updateGpsEntry(req, res) {
    let connection;
    try {
        const id = req.params.id;

        // Destructure editable fields from request body
        const {
            name,
            lattitude,
            longitude,
            type,
            blk_code,
            blk_name,
            dt_code,
            dt_name,
            st_code,
            st_name,
            lgd_code,
            remark
        } = req.body;

        if (!id) {
            return res.status(400).send({
                status: false,
                message: "ID is required to update the GPS record"
            });
        }

        connection = await pool.getConnection();
        const updateQuery = `
            UPDATE gpslist SET 
                name = ?, 
                lattitude = ?, 
                longitude = ?, 
                type = ?, 
                blk_code = ?, 
                blk_name = ?, 
                dt_code = ?, 
                dt_name = ?, 
                st_code = ?, 
                st_name = ?, 
                lgd_code = ?, 
                remark = ?, 
                updated_at = CURRENT_TIMESTAMP()
            WHERE id = ?
        `;

        const [result] = await connection.execute(updateQuery, [
            name,
            lattitude,
            longitude,
            type,
            blk_code,
            blk_name,
            dt_code,
            dt_name,
            st_code,
            st_name,
            lgd_code,
            remark,
            id
        ]);

        if (result.affectedRows === 0) {
            return res.status(404).send({
                status: false,
                message: "No GPS record found with the given ID"
            });
        }

        return res.status(200).send({
            status: true,
            message: "GPS record updated successfully",
            updatedId: id
        });

    } catch (error) {
        console.error("Error updating GPS record:", error);
        return res.status(500).send({
            status: false,
            message: "Internal Server Error",
            error: error.message
        });
    } finally {
        if (connection) connection.release?.();
    }
}


//------------------------------------smart - inventory------------------------------------


function extractText(parent, tagName) {
    const el = parent.getElementsByTagName(tagName)[0];
    return el && el.textContent ? el.textContent.trim() : null;
}

function parseDescriptionFields(description) {
    if (!description) return {};

    // Normalize whitespace: collapse multiple blank lines, remove carriage returns
    description = description.replace(/\r/g, '').replace(/\n{2,}/g, '\n').trim();

    const fields = {};

    // Helper: only accept clean keys (no embedded \n and not insanely long)
    const isValidKey = key =>
        key &&
        !key.includes('\n') &&
        key.length <= 50 && // avoid giant keys
        /^[\w\s-]+$/.test(key.trim()); // letters, numbers, underscores, spaces, dash

    // 1. Try HTML table parsing
    if (description.includes('<tr') && description.includes('<td')) {
        try {
            const parser = new DOMParser();
            const doc = parser.parseFromString(description, 'text/html');
            const rows = doc.getElementsByTagName('tr');

            for (let i = 0; i < rows.length; i++) {
                const cells = rows[i].getElementsByTagName('td');
                if (cells.length >= 2) {
                    const key = cells[0].textContent.trim();
                    const value = cells[1].textContent.trim();
                    if (isValidKey(key)) fields[key] = value;
                }
            }
            return fields;
        } catch (err) {
            console.warn('Failed HTML description parse, falling back:', err.message);
        }
    }

    // 2. Try key: value or key = value parsing
    const regex = /([\w\s-]+)\s*[:=]\s*([^\n\r]+)/g;
    let match;
    let foundAny = false;
    while ((match = regex.exec(description)) !== null) {
        const key = match[1].trim();
        const value = match[2].trim();
        if (isValidKey(key)) {
            fields[key] = value;
            foundAny = true;
        }
    }
    if (foundAny) return fields;

    // 3. Fallback: key\nvalue pairing
    const lines = description.split(/\n+/).map(s => s.trim()).filter(Boolean);
    if (lines.length >= 2) {
        for (let i = 0; i < lines.length - 1; i += 2) {
            const key = lines[i];
            const value = lines[i + 1];
            if (isValidKey(key)) {
                fields[key] = value ?? '';
            }
        }
    }

    return fields;
}



function parseKmz(buffer) {
    const zip = new AdmZip(buffer);
    const kmlFile = zip.getEntries().find(e => e.entryName.endsWith('.kml'));

    if (!kmlFile) throw new Error('KML not found inside KMZ');

    const kmlContent = kmlFile.getData().toString('utf8');
    const dom = new DOMParser().parseFromString(kmlContent, 'text/xml');

    const placemarks = dom.getElementsByTagName('Placemark');
    const points = [];
    const lines = [];

    for (let i = 0; i < placemarks.length; i++) {
        const placemark = placemarks[i];
        const name = extractText(placemark, 'name');
        const point = placemark.getElementsByTagName('Point')[0];
        const line = placemark.getElementsByTagName('LineString')[0];

        const description = extractText(placemark, 'description');
        const descriptionFields = parseDescriptionFields(description);

        const extendedData = placemark.getElementsByTagName('ExtendedData')[0];
        const extendedProps = {};
        if (extendedData) {
            const dataTags = extendedData.getElementsByTagName('Data');
            for (let j = 0; j < dataTags.length; j++) {
                const nameAttr = dataTags[j].getAttribute('name');
                const value = extractText(dataTags[j], 'value');
                extendedProps[nameAttr] = value;
            }
        }

        const properties = { ...descriptionFields, ...extendedProps };

        const getTypeValue = () => {
            if (extendedData) {
                const dataTags = extendedData.getElementsByTagName('Data');
                for (let j = 0; j < dataTags.length; j++) {
                    const nameAttr = dataTags[j].getAttribute('name')?.toLowerCase();
                    const value = extractText(dataTags[j], 'value');
                    if (nameAttr && nameAttr.includes('type')) {
                        return value;
                    }
                }
            }
            if (descriptionFields.asset_type) return descriptionFields.asset_type;
            if (descriptionFields.type) return descriptionFields.type;
            if (descriptionFields.loc_type) return descriptionFields.loc_type;

            if (description) {
                const match = description.match(/(?:type|loc_type|asset_type)\s*[:=]\s*([\w\s]+)/i);
                if (match) return match[1].trim();
            }
            return null;
        };

        if (point) {
            const coordText = extractText(point, 'coordinates');
            const coords = coordText?.split(',').map(Number);
            const type = getTypeValue();
            points.push({ name, coordinates: coords, type, properties });
        }

        if (line) {
            const coordText = extractText(line, 'coordinates');
            const coords = coordText
                .trim()
                .split(/\s+/)
                .map(s => s.split(',').map(Number));

            let length = null;
            if (extendedData) {
                const dataTags = extendedData.getElementsByTagName('Data');
                for (let j = 0; j < dataTags.length; j++) {
                    const nameAttr = dataTags[j].getAttribute('name');
                    const value = extractText(dataTags[j], 'value');
                    if (nameAttr === 'length') length = value;
                }
            }

            const type = getTypeValue();
            lines.push({ name, coordinates: coords, length, type, properties });
        }
    }

    return { points, lines };
}




// async function downloadshape(req, res) {
//   try {
//     const { parsed_data } = req.body;
//     const zip = new AdmZip();

//     // Helper: split MultiLineStrings into single LineStrings
//     const explodeLines = (polyline) => {
//       const coords = polyline.coordinates || [];
//       if (Array.isArray(coords[0][0])) {
//         return coords.map((part) => ({
//           geometry: { type: "LineString", coordinates: part },
//           properties: polyline.properties || {},
//         }));
//       }
//       return [
//         {
//           geometry: { type: "LineString", coordinates: coords },
//           properties: polyline.properties || {},
//         },
//       ];
//     };

//     // Helper to add shapefile + Excel using shpwrite.zip (for points layers)
//     const addLayer = (features, layerName) => {
//       if (!features.length) return;

//       // Ensure all features have the same property keys
//       const allKeys = [...new Set(features.flatMap((f) => Object.keys(f.properties || {})))];

//       // Fill missing keys with null
//       const normalizedFeatures = features.map((f) => {
//         const props = {};
//         allKeys.forEach((k) => {
//           props[k] = f.properties && k in f.properties ? f.properties[k] : null;
//         });
//         return { ...f, properties: props };
//       });

//       const geojson = { type: "FeatureCollection", features: normalizedFeatures };
//       const shapefileBuffer = shpwrite.zip(geojson);
//       const layerZip = new AdmZip(shapefileBuffer);

//       layerZip.getEntries().forEach((entry) => {
//         const ext = entry.entryName.split(".").pop();
//         zip.addFile(`${layerName}.${ext}`, entry.getData());
//       });

//       // Create Excel
//       const worksheet = XLSX.utils.json_to_sheet(normalizedFeatures.map((f) => f.properties));
//       const workbook = XLSX.utils.book_new();
//       XLSX.utils.book_append_sheet(workbook, worksheet, layerName);
//       const excelBuffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
//       zip.addFile(`${layerName}.xlsx`, excelBuffer);
//     };

//     // New helper: add polyline layer using shpwrite.write (for OFC)
//     const addPolylineLayerSeparate = (features, layerName) => {
//       if (!features.length) return;

//       // Normalize properties keys
//       const allKeys = [...new Set(features.flatMap((f) => Object.keys(f.properties || {})))];

//       // Prepare data and geometries arrays for shpwrite.write
//       const data = [];
//       const geometries = [];

//       features.forEach((f) => {
//         const props = {};
//         allKeys.forEach((k) => {
//           props[k] = f.properties && k in f.properties ? f.properties[k] : null;
//         });
//         data.push(props);
//         geometries.push(f.geometry.coordinates);
//       });

//       shpwrite.write(data, "POLYLINE", geometries, (err, result) => {
//         if (err) {
//           console.error("Error in shpwrite.write:", err);
//           return;
//         }

//         // Convert DataViews to Buffers
//         const shpBuffer = Buffer.from(result.shp.buffer);
//         const shxBuffer = Buffer.from(result.shx.buffer);
//         const dbfBuffer = Buffer.from(result.dbf.buffer);

//         zip.addFile(`${layerName}.shp`, shpBuffer);
//         zip.addFile(`${layerName}.shx`, shxBuffer);
//         zip.addFile(`${layerName}.dbf`, dbfBuffer);

//         // Add basic WGS84 prj file


//         // Add Excel sheet
//         const worksheet = XLSX.utils.json_to_sheet(data);
//         const workbook = XLSX.utils.book_new();
//         XLSX.utils.book_append_sheet(workbook, worksheet, layerName);
//         const excelBuffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
//         zip.addFile(`${layerName}.xlsx`, excelBuffer);
//       });
//     };

//     // Prepare GP features (points)
//     const gpFeatures = parsed_data.points
//       .filter((p) => (p.type || "").toUpperCase() === "GP")
//       .map((p) => ({
//         type: "Feature",
//         geometry: { type: "Point", coordinates: [p.coordinates.longitude, p.coordinates.latitude] },
//         properties: p.properties || {},
//       }));

//     // Prepare FPOI features (points)
//     const fpoiFeatures = parsed_data.points
//       .filter((p) => (p.type || "").toUpperCase() !== "GP")
//       .map((p) => ({
//         type: "Feature",
//         geometry: { type: "Point", coordinates: [p.coordinates.longitude, p.coordinates.latitude] },
//         properties: p.properties || {},
//       }));

//     // Prepare OFC features (lines)
//     let ofcFeatures = [];
//     parsed_data.polylines.forEach((l) => {
//       explodeLines(l).forEach((line) => {
//         const props = { ...line.properties };
//         if (props.type === "Proposed Cable") {
//           props.stroke = "#FF0000";
//         } else if (props.type === "Incremental Cable") {
//           props.stroke = "#00FF00";
//         } else {
//           props.stroke = "#000000";
//         }
//         ofcFeatures.push({
//           type: "Feature",
//           geometry: line.geometry,
//           properties: props,
//         });
//       });
//     });

//     console.log("OFC features geometry types:");
//     ofcFeatures.forEach((f, i) => console.log(i, f.geometry.type));

//     // Add GP and FPOI layers using existing method
//     addLayer(gpFeatures, "GP");
//     addLayer(fpoiFeatures, "FPOI");

//     // Add OFC layer using new method for separate line features
//     addPolylineLayerSeparate(ofcFeatures, "OFC");

//     // Wait a bit for async write callback in addPolylineLayerSeparate to finish
//     // (Because shpwrite.write is async but callback based, we need a Promise here)
//     await new Promise((resolve) => setTimeout(resolve, 1000));

//     // Save zip to disk
//     const buffer = zip.toBuffer();
//     const outputPath = path.join(__dirname, "shapefilesddd_output.zip");
//     fs.writeFileSync(outputPath, buffer);

//     // Send response
//     res.set({
//       "Content-Type": "application/zip",
//       "Content-Disposition": 'attachment; filename="shapefiles.zip"',
//     });
//     res.send(buffer);
//   } catch (err) {
//     console.error(err);
//     res.status(500).json({ message: "Error generating shapefiles", error: err.message });
//   }
// }    



async function downloadshape(req, res) {
    try {
        const { parsed_data } = req.body;
        const zip = new AdmZip();

        // WGS84 projection file content
        const wgs84prj = `GEOGCS["WGS 84",
            DATUM["WGS_1984",
                SPHEROID["WGS 84",6378137,298.257223563,
                AUTHORITY["EPSG","7030"]],
                AUTHORITY["EPSG","6326"]],
            PRIMEM["Greenwich",0,
                AUTHORITY["EPSG","8901"]],
            UNIT["degree",0.0174532925199433,
                AUTHORITY["EPSG","9102"]],
            AUTHORITY["EPSG","4326"]]`;
        // Split MultiLineString into individual LineStrings
        const explodeLines = (polyline) => {
            const coords = polyline.coordinates || [];
            if (Array.isArray(coords[0][0])) {
                return coords.map((part) => ({
                    geometry: { type: "LineString", coordinates: part },
                    properties: polyline.properties || {},
                }));
            }
            return [
                {
                    geometry: { type: "LineString", coordinates: coords },
                    properties: polyline.properties || {},
                },
            ];
        };

        // Add point layers
        const addLayer = (features, layerName) => {
            if (!features.length) return;

            const allKeys = [...new Set(features.flatMap((f) => Object.keys(f.properties || {})))];
            const normalizedFeatures = features.map((f) => {
                const props = {};
                allKeys.forEach((k) => {
                    props[k] = f.properties && k in f.properties ? f.properties[k] : null;
                });
                return { ...f, properties: props };
            });

            const geojson = { type: "FeatureCollection", features: normalizedFeatures };
            const shapefileBuffer = shpwrite.zip(geojson);
            const layerZip = new AdmZip(shapefileBuffer);

            layerZip.getEntries().forEach((entry) => {
                const ext = entry.entryName.split(".").pop();
                zip.addFile(`${layerName}.${ext}`, entry.getData());
            });

            zip.addFile(`${layerName}.prj`, Buffer.from(wgs84prj, "utf8"));
        };

        // Add polyline layers (separate features)
        const addPolylineLayerSeparate = (features, layerName) => {
            return new Promise((resolve, reject) => {
                if (!features.length) return resolve();

                const allKeys = [...new Set(features.flatMap((f) => Object.keys(f.properties || {})))];
                const data = [];
                const geometries = [];

                features.forEach((f) => {
                    const props = {};
                    allKeys.forEach(k => props[k] = f.properties?.[k] ?? null);
                    data.push(props);

                    // Wrap in array for "parts"
                    const coords2D = f.geometry.coordinates.map(c => [c[0], c[1]]);
                    geometries.push([coords2D]);
                });

                shpwrite.write(
                    data,
                    "POLYLINE",
                    geometries,
                    (err, result) => {
                        if (err) return reject(err);

                        zip.addFile(`${layerName}.shp`, Buffer.from(result.shp.buffer));
                        zip.addFile(`${layerName}.shx`, Buffer.from(result.shx.buffer));
                        zip.addFile(`${layerName}.dbf`, Buffer.from(result.dbf.buffer));
                        zip.addFile(`${layerName}.prj`, Buffer.from(wgs84prj, "utf8"));

                        resolve();
                    }
                );
            });
        };

        // Prepare GP features
        const gpFeatures = parsed_data.points
            .filter((p) => (p.type || "").toUpperCase() === "GP")
            .map((p) => ({
                type: "Feature",
                geometry: { type: "Point", coordinates: [p.coordinates.longitude, p.coordinates.latitude] },
                properties: p.properties || {},
            }));

        // Prepare FPOI features
        const fpoiFeatures = parsed_data.points
            .filter((p) => (p.type || "").toUpperCase() !== "GP")
            .map((p) => ({
                type: "Feature",
                geometry: { type: "Point", coordinates: [p.coordinates.longitude, p.coordinates.latitude] },
                properties: p.properties || {},
            }));

        // Prepare OFC features
        let ofcFeatures = [];
        parsed_data.polylines.forEach((l) => {
            explodeLines(l).forEach((line) => {
                const props = { ...line.properties };
                if (props.type === "Proposed Cable") {
                    props.stroke = "#FF0000";
                } else if (props.type === "Incremental Cable") {
                    props.stroke = "#00FF00";
                } else {
                    props.stroke = "#000000";
                }
                ofcFeatures.push({
                    type: "Feature",
                    geometry: line.geometry,
                    properties: props,
                });
            });
        });

        // Add layers
        addLayer(gpFeatures, "GP");
        addLayer(fpoiFeatures, "FPOI");
        await addPolylineLayerSeparate(ofcFeatures, "OFC");


        // Add any other point-type layers dynamically
        Object.keys(parsed_data).forEach(key => {
            if (
                Array.isArray(parsed_data[key]) &&
                key !== 'points' &&
                key !== 'polylines'
            ) {
                const feats = parsed_data[key]
                    .filter(p => p.coordinates && typeof p.coordinates.longitude === 'number' && typeof p.coordinates.latitude === 'number')
                    .map(p => ({
                        type: "Feature",
                        geometry: { type: "Point", coordinates: [p.coordinates.longitude, p.coordinates.latitude] },
                        properties: p.properties || {}
                    }));

                if (feats.length) {
                    addLayer(feats, key); // exports shapefile into zip
                }
            }
        });

        // Send zip
        const buffer = zip.toBuffer();
        //fs.writeFileSync("shapefilesall.zip", buffer)
        res.set({
            "Content-Type": "application/zip",
            "Content-Disposition": 'attachment; filename="shapefiles.zip"',
        });
        res.send(buffer);

    } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Error generating shapefiles", error: err.message });
    }
}

const XLSX = require("xlsx");

function downloadExcel(req, res) {
    try {
        const { parsed_data } = req.body;
        const wb = XLSX.utils.book_new();

        // Helper to add sheet
        const addSheet = (name, features) => {
            if (!features.length) return;

            const allKeys = [...new Set(features.flatMap(f => Object.keys(f.properties || {})))];
            const rows = [
                ["longitude", "latitude", ...allKeys] // header row
            ];

            features.forEach(f => {
                rows.push([
                    f.coordinates.longitude,
                    f.coordinates.latitude,
                    ...allKeys.map(k => f.properties?.[k] ?? "")
                ]);
            });

            const ws = XLSX.utils.aoa_to_sheet(rows);
            XLSX.utils.book_append_sheet(wb, ws, name);
        };

        // GP
        const gpFeatures = parsed_data.points.filter(p => (p.type || "").toUpperCase() === "GP");
        addSheet("GP", gpFeatures);

        // FPOI
        const fpoiFeatures = parsed_data.points.filter(p => (p.type || "").toUpperCase() !== "GP");
        addSheet("FPOI", fpoiFeatures);

        // OFC (polylines → first coordinate)
        const ofcRows = parsed_data.polylines.map(l => ({
            coordinates: { 
                longitude: l.geometry?.coordinates?.[0]?.[0] ?? null,
                latitude: l.geometry?.coordinates?.[0]?.[1] ?? null
            },
            properties: l.properties || {}
        }));
        addSheet("OFC", ofcRows);

        // Other arrays in parsed_data
        Object.keys(parsed_data).forEach(key => {
            if (Array.isArray(parsed_data[key]) && key !== 'points' && key !== 'polylines') {
                addSheet(key, parsed_data[key]);
            }
        });

        // Generate Excel buffer
        const buffer = XLSX.write(wb, { bookType: "xlsx", type: "buffer" });

        res.setHeader("Content-Disposition", 'attachment; filename="data.xlsx"');
        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.send(buffer);
        //fs.writeFileSync('excel.xlsx', buffer )

    } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Error generating Excel", error: err.message });
    }
}



module.exports = { getSurveysByLocation, uploadExternalData, getEXternalfiles, previewfile, insertFpoi, getGpsListPaginated, filterGpsList, updateGpsEntry, parseKmz, downloadshape, downloadExcel, getdesktopPlanning }
