const express = require('express');
const multer = require('multer');
const fs = require('fs');
const toGeoJSON = require('@tmcw/togeojson');
const { DOMParser } = require('xmldom');
const path = require('path');
const axios = require('axios');
const polyline = require('@mapbox/polyline');
const xml2js = require('xml2js');
const cors = require('cors');
const mysql = require('mysql2/promise');
const { create } = require('xmlbuilder2');
const AdmZip = require('adm-zip');
const { json } = require('stream/consumers');

//local db 


const pool = require("../db");

let globalPoints = null;
let mainPointName = null;

function calculateDistance(coord1, coord2) {
    let lat1, lon1, lat2, lon2;
    if (Array.isArray(coord1) && coord1.length >= 2) {
        [lon1, lat1] = coord1;
    } else {
        throw new Error('Invalid coordinates format for coord1');
    }
    if (Array.isArray(coord2) && coord2.length >= 2) {
        [lon2, lat2] = coord2;
    } else {
        throw new Error('Invalid coordinates format for coord2');
    }
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

const googleMapsApiKey = 'AIzaSyCPHNQoyCkDJ3kOdYZAjZElbhXuJvx-Odg';


async function getRoute(fromCoordinates, toCoordinates) {
    const isValidCoords = (coords) =>
        Array.isArray(coords) &&
        coords.length === 2 &&
        typeof coords[0] === 'number' &&
        typeof coords[1] === 'number' &&
        !isNaN(coords[0]) &&
        !isNaN(coords[1]);

    if (!isValidCoords(fromCoordinates) || !isValidCoords(toCoordinates)) {
        console.warn('âš ï¸ Skipping invalid route coordinates:', {
            from: fromCoordinates,
            to: toCoordinates,
        });
        return null;
    }

    if (fromCoordinates[0] === toCoordinates[0] && fromCoordinates[1] === toCoordinates[1]) {
        return null;
    }

    try {
        const response = await axios.get('https://maps.googleapis.com/maps/api/directions/json', {
            params: {
                origin: `${fromCoordinates[1]},${fromCoordinates[0]}`,
                destination: `${toCoordinates[1]},${toCoordinates[0]}`,
                key: googleMapsApiKey,
                mode: 'driving',
            },
        });

        const routeData = response.data;
        if (routeData.status !== 'OK') {
            console.error('Google Maps API Error:', routeData.status, routeData.error_message || '');
            return null;
        }

        const route = routeData.routes[0];
        if (!route) {
            console.warn('No routes found between coordinates:', fromCoordinates, toCoordinates);
            return null;
        }

        const polylinePoints = route.overview_polyline.points;
        const coordinates = polyline.decode(polylinePoints).map(([lat, lng]) => [lng, lat]);
        const distance = route.legs.reduce((sum, leg) => sum + leg.distance.value, 0);

        return {
            type: 'FeatureCollection',
            features: [
                {
                    type: 'Feature',
                    geometry: {
                        type: 'LineString',
                        coordinates,
                    },
                    properties: {
                        segments: [{ distance }],
                    },
                },
            ],
        };
    } catch (error) {
        console.error('âŒ Error fetching route from Google Maps:', error?.response?.data || error.message);
        return null;
    }
}


function normalizeName(name) {
    console.log(name, "rawname")
    if ((name) && name !== undefined)
        return name
            .trim()
            .replace(/\s*\([^)]+\)/, '')
            .replace(/\s+/g, '-')
            .toUpperCase();
}

function getMidpoint(coordinates) {
    if (!coordinates || coordinates.length < 2) return null;
    let totalLat = 0, totalLng = 0, count = 0;
    coordinates.forEach(coord => {
        if (coord[0] && coord[1]) {
            totalLng += coord[0]; // lon
            totalLat += coord[1]; // lat
            count++;
        }
    });
    if (count === 0) return null;
    return { lng: totalLng / count, lat: totalLat / count };
}

async function insertversion(req, res) {
  let connection;
  try {
    const { id, version } = req.body;

    if (!id || !version) {
      return res.status(400).json({
        error: "Id or Version is missing",
        details: "Both fields are required",
      });
    }

    connection = await pool.getConnection();
    await connection.beginTransaction();

    // Check if record exists in underground_fiber_surveys
    const [record] = await connection.query(
      "SELECT id FROM underground_fiber_surveys WHERE id = ?",
      [id]
    );

    if (record.length === 0) {
      await connection.rollback();
      return res.status(404).json({
        error: "Record not found",
        details: `No record exists in underground_fiber_surveys with id ${id}`,
      });
    }

    // Update version
    await connection.query(
      "UPDATE underground_fiber_surveys SET versions = ? WHERE id = ?",
      [version, id]
    );

    await connection.commit();

    return res.status(200).json({
      message: "Version updated successfully in underground_fiber_surveys",
      data: { id, version },
    });
  } catch (err) {
    if (connection) await connection.rollback();
    console.error("? Version update error:", err);
    res.status(500).json({
      error: "Failed to update version",
      details: err.message,
    });
  } finally {
    if (connection) connection.release();
  }
}

async function uploadPoints(req, res) {
    try {
        const pointsPath = req.file.path;
        const pointsKmlData = fs.readFileSync(pointsPath, 'utf8');
        const pointsKml = new DOMParser().parseFromString(pointsKmlData, 'text/xml');
        const pointsGeoJson = toGeoJSON.kml(pointsKml);

        const rawPoints = new Map();
        const blockRouterFeature = pointsGeoJson.features.find(f => {
            const props = f.properties || {};
            const rawDesc = props.description || '';
            const typeFromExtended = props['type'] || props['ExtendedData']?.type;
            return (
                (typeof rawDesc === 'string' && rawDesc.toLowerCase().includes('block router')) ||
                (typeof typeFromExtended === 'string' && typeFromExtended.toLowerCase() === 'block router')
            );
        });

        const originalFileName = req.file.originalname;
        mainPointName = pointsPath
        // if (!mainPointName) throw new Error('âŒ Main point (Block Router) not found.');
        // console.log('âœ… Detected Main Point:', mainPointName);

        const pointsWithoutLgd = [];

        pointsGeoJson.features.forEach(feature => {
            if (feature.geometry.type === 'Point') {
                let name = feature.properties.name?.trim() || '';
                mainPointName = feature.properties.blk_name?.trim() || '';
                name = normalizeName(name);
                console.log(name);
                const coordinates = feature.geometry.coordinates;
                const properties = { ...feature.properties };
                delete properties.description;

                // Process ExtendedData
                if (properties.ExtendedData) {
                    Object.entries(properties.ExtendedData).forEach(([key, value]) => {
                        properties[key] = value === 'NULL' ? null : value;
                    });
                    delete properties.ExtendedData;
                }

                // Check for LGD code
                // const lgdCode = properties.lgd_code || properties.LGDCode || properties.lgd; // Adjust key name(s) as needed
                // if (!lgdCode || lgdCode === 'NULL' || lgdCode === '') {
                //     pointsWithoutLgd.push(name || 'Unnamed Point');
                // }

                if (!rawPoints.has(name)) {
                    rawPoints.set(name, {
                        name,
                        coordinates: coordinates.slice(0, 2),
                        properties,
                        styleUrl: feature.properties.styleUrl || null,
                    });
                }
            }
        });

        // Throw error if any points lack LGD codes
        // if (pointsWithoutLgd.length > 0) {
        //     throw new Error(`âŒ The following points are missing LGD codes: ${pointsWithoutLgd.join(', ')}`);
        // }

        globalPoints = Array.from(rawPoints.values());
        fs.unlinkSync(pointsPath);
        res.json({
            points: globalPoints,
            mainPointName,
        });
    } catch (err) {
        console.error('âŒ Points processing error:', err);
        res.status(500).json({ error: 'Failed to process points KML file', details: err.message });
    }
};


async function uploadConnection(req, res) {
    try {
        const connectionsPath = req.file.path;
        const connectionsKmlData = fs.readFileSync(connectionsPath, 'utf8');
        const connectionsKml = new DOMParser().parseFromString(connectionsKmlData, 'text/xml');
        const connectionsGeoJson = toGeoJSON.kml(connectionsKml);

        const connections = [];

        connectionsGeoJson.features.forEach(feature => {
            if (feature.geometry.type === 'LineString') {
                const name = feature.properties.name?.trim() || '';
                const toIndex = name.toLowerCase().lastIndexOf(' to ');

                const startName = toIndex !== -1 ? name.substring(0, toIndex).trim() : '';
                const endName = toIndex !== -1 ? name.substring(toIndex + 4).trim() : '';

                const coordinates = feature.geometry.coordinates;

                const length =
                    parseFloat(
                        feature.properties.len ||
                        feature.properties.length ||
                        feature.properties['Data.length'] ||
                        feature.properties.seg_length ||
                        0
                    );

                let color = '#28a745';
                const rgbColor = feature.properties.LINE_COLOR?.match(/RGB\((\d+),(\d+),(\d+)\)/);
                if (rgbColor) {
                    const [, r, g, b] = rgbColor;
                    color = `#${parseInt(r).toString(16).padStart(2, '0')}${parseInt(g).toString(16).padStart(2, '0')}${parseInt(b).toString(16).padStart(2, '0')}`;
                }

                connections.push({
                    name,
                    start: startName,
                    end: endName,
                    coordinates: coordinates.map(([lng, lat]) => [lng, lat]),
                    length,
                    color,
                    existing: true
                });
            }
        });

        fs.unlinkSync(connectionsPath);

        res.json({
            connections,
            count: connections.length
        });
    } catch (err) {
        console.error('âŒ Connections processing error:', err);
        res.status(500).json({ error: 'Failed to process connections KML file', details: err.message });
    }
}



async function showRoute(req, res) {
    try {
        const { lat1, lng1, lat2, lng2 } = req.query;
        const origin = { lat: parseFloat(lat1), lng: parseFloat(lng1) };
        const destination = { lat: parseFloat(lat2), lng: parseFloat(lng2) };

        if (isNaN(origin.lat) || isNaN(origin.lng) || isNaN(destination.lat) || isNaN(destination.lng)) {
            return res.status(400).json({ error: 'Invalid coordinates provided.' });
        }

        const response = await axios.get('https://maps.googleapis.com/maps/api/directions/json', {
            params: {
                origin: `${origin.lat},${origin.lng}`,
                destination: `${destination.lat},${destination.lng}`,
                key: googleMapsApiKey,
                alternatives: true,
            },
        });

        const routeData = response.data;
        if (routeData.status !== 'OK') {
            console.error('Google Maps API Error:', routeData);
            return res.status(500).json({
                error: `Google Maps API error: ${routeData.status}`,
                details: routeData.error_message || 'No additional details available',
            });
        }

        console.log(routeData.routes, 'routes')

        const routes = routeData.routes.slice(0, 3);
        if (!routes.length) {
            return res.status(404).json({ error: 'No routes found' });
        }

        const result = routes.map(route => {
            const overviewPolyline = route.overview_polyline?.points;
            if (!overviewPolyline) return null;
            const points = polyline.decode(overviewPolyline);
            let distance = 0;
            route.legs.forEach(leg => {
                distance += leg.distance.value;
            });
            distance = distance / 1000;
            return { route: points, distance };
        }).filter(r => r !== null);

        if (!result.length) {
            return res.status(404).json({ error: 'No valid routes found' });
        }

        res.json(result);
    } catch (error) {
        console.error('Error fetching routes from Google Maps:', error);
        res.status(500).json({ error: 'Failed to fetch routes', details: error.message });
    }
};


function normalizeCoordinates(coord) {
    if (Array.isArray(coord)) {
        // [latitude,longitude]
        return [
            Number.isFinite(coord[0]) ? Number(coord[0].toFixed(6)) : null,
            Number.isFinite(coord[1]) ? Number(coord[1].toFixed(6)) : null
        ];


    } else if (coord && typeof coord === 'object' && 'lat' in coord && 'lng' in coord) {
        // {lat, lng}
        return [
            Number.isFinite(coord.lat) ? Number(coord.lat.toFixed(6)) : null,
            Number.isFinite(coord.lng) ? Number(coord.lng.toFixed(6)) : null
        ];
    }


    console.log(coord)
    console.warn('Invalid coordinate format:', coord);
    return null;
}

function roundCoordinates(coords) {
    if (!Array.isArray(coords)) {
        console.warn('Invalid coordinates: Not an array', coords);
        return [];
    }
    return coords
        .map(coord => normalizeCoordinates(coord))
        .filter(coord => coord && coord[0] !== null && coord[1] !== null);
}

// Validate LineString
function isValidLineString(coordinates, minDistanceKm = 0.00001) { // ~1 meter
    if (!coordinates || coordinates.length < 2) {
        console.warn(`Invalid LineString: Fewer than 2 coordinates`);
        return false;
    }
    const uniqueCoords = new Set(coordinates.map(c => `${c[0].toFixed(6)},${c[1].toFixed(6)}`));
    if (uniqueCoords.size < 2) {
        console.warn(`Invalid LineString: All coordinates are identical`);
        return false;
    }
    for (let i = 1; i < coordinates.length; i++) {
        const dist = calculateDistance(coordinates[i - 1], coordinates[i]);
        if (dist >= minDistanceKm) return true;
    }
    console.warn(`Invalid LineString: Coordinates too close (dist < ${minDistanceKm} km)`);
    return false;
}


async function savetodb(req, res) {
    let connection;
    try {
        const { globalData, polylineHistory, user_id, user_name } = req.body;

        if (!globalData || !globalData.loop || !globalData.mainPointName || !polylineHistory || !user_id || !user_name) {
            throw new Error('Missing required fields: globalData.loop, globalData.mainPointName, or polylineHistory');
        }

        // ---- Validation ----
        //1. Check lgd_code for all points
        for (const point of globalData.loop) {
            //console.log(point.lgd_code)
            if (!point.lgd_code || point.lgd_code.toString().trim() === "" || point.lgd_code == 'NULL') {
                //console.log("notherebro")
                 point.lgd_code == '0000'
            }
        }

        // 2. Check startCords & endCords for all connections
        for (const [key, data] of Object.entries(polylineHistory)) {
            const startCords = data.segmentData?.startCords;
            const endCords = data.segmentData?.endCords;

            if (!startCords || !endCords) {
                throw new Error(`Missing startCords or endCords in connection: ${key}`);
            }
        }

        // Extract data
        let totalLength = globalData.totalLength;
        let extlength = globalData.existinglength;
        let proposedlength = globalData.proposedlength;
        let dt_code = globalData.dt_code;
        let dt_name = globalData.dt_name;
        let st_code = globalData.st_code;
        let st_name = globalData.st_name;
        let blk_code = globalData.blk_code
        let blk_name = globalData.blk_name

        if (!dt_code || !dt_name || !st_code || !st_name || !blk_code || !blk_name) {
            throw new Error('Missing required fields: st_code, st_name, dt_code, dt_name, blk_name, blk_code');
        }


        connection = await pool.getConnection();
        await connection.beginTransaction();

        // Insert into networks
        const networkName = globalData.mainPointName;
        const [networkResult] = await connection.execute(
            `INSERT INTO networks 
            (name, total_length, main_point_name, existing_length, proposed_length, dt_code, dt_name, st_code, st_name, blk_code, blk_name, user_id, user_name, status) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [networkName, totalLength, networkName, extlength, proposedlength, dt_code, dt_name, st_code, st_name, blk_code, blk_name, user_id, user_name, "verified"]
        );
        const networkId = networkResult.insertId;

        // Insert unique points and build map { name -> id }
        const pointIdMap = new Map();
        for (const point of globalData.loop) {
            if (!point.name || !point.coordinates) {
                console.warn(`Skipping point: Invalid name or coordinates, point`);
                continue;
            }

            const normalizedName = point.name.trim();
            if (!pointIdMap.has(normalizedName)) {
                const coords = normalizeCoordinates(point.coordinates);
                if (!coords || coords[0] === null || coords[1] === null) {
                    console.warn(`Skipping point: Invalid coordinates for ${normalizedName}, point.coordinates`);
                    continue;
                }

                const [pointResult] = await connection.execute(
                    `INSERT INTO points (network_id, name, coordinates, lgd_code, properties) 
                     VALUES (?, ?, ?, ?, ?)`,
                    [networkId, normalizedName, JSON.stringify(coords),  point.lgd_code || "0000", point.properties]
                );

                pointIdMap.set(normalizedName, pointResult.insertId);
            }
        }

        // Insert connections
        for (const [key, data] of Object.entries(polylineHistory)) {
            const startCode = data.segmentData?.startCords;
            const endCode = data.segmentData?.endCords;
            const parts = key.split("To");
            let startname = parts[0];
            let endname = parts[1];
            //console.log(startname, endname)
            if (!startCode || !endCode) {
                console.warn(`Skipping connection ${key}: Missing startCords or endCords`);
                continue;
            }

            let coordinates = [];
            if (Array.isArray(data.polyline)) {
                coordinates = data.polyline;
            } else if (data.polyline?.coordinates) {
                coordinates = data.polyline.coordinates;
            } else if (data.route?.features?.[0]?.geometry?.coordinates) {
                coordinates = data.route.features[0].geometry.coordinates;
            }

            coordinates = roundCoordinates(coordinates);
            if (!isValidLineString(coordinates)) {
                console.warn(`Skipping connection ${key}: Invalid coordinates`);
                continue;
            }

            const length = data.segmentData?.connection?.length ||
                (coordinates.length >= 2 ? calculateDistance(coordinates[0], coordinates[coordinates.length - 1]) : 0);

            const color = data.segmentData?.connection?.color || '#000000';
            const type = (data.segmentData?.connection?.existing === true) ? "existing" : "proposed";
            const properties = data.segmentData?.properties || '';

           await connection.execute(
    `INSERT INTO connections 
    (network_id, start, end, length, original_name, coordinates, color, start_latlong, end_latlong, type, properties, status) 
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [networkId, startCode, endCode, length, key, JSON.stringify(coordinates), color, startCode, endCode, type, properties, "Pending"]
);        }

          // ? Update block_status.desktop_status = 'Completed'
                 await connection.execute(
                `UPDATE block_status 
                SET desktop_status = 'Completed', 
                    desktop_startDate = IFNULL(desktop_startDate, CURDATE()), 
                    desktop_endDate = CURDATE(),
                    proposed_length = ?, 
                    incremental_length = ?
                WHERE block_id = ?`,
                [proposedlength, extlength, blk_code]
            );
        await connection.commit();
        res.json({ success: true, networkId, message: 'Data saved to database' });

    } catch (err) {
        if (connection) await connection.rollback();
        console.error('Error saving to database:', {
            message: err.message,
            stack: err.stack,
        });
        res.status(500).json({ success: false, details: err.message });
    } finally {
        if (connection) connection.release();
    }
}


async function saveproperties(req, res) {
    let connection;
    try {
        const { type, properties, id } = req.body;

        if (!type || !properties || !id) {
            return res.status(400).json({ error: "Missing required fields" });
        }

        // Convert properties to string (safe for JSON)
        const propertiesString = JSON.stringify(properties);

        // Decide table name
        let table;
        if (type === "point") {
            table = "points";
        } else if (type === "line") {
            table = "connections";
        } else {
            return res.status(400).json({ error: "Invalid type, must be 'point' or 'line'" });
        }

        // Connect to DB
        connection = await pool.getConnection();

        // Update query
        const [result] = await connection.query(
            `UPDATE ${table} SET properties = ? WHERE id = ?`,
            [propertiesString, id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: "Row not found" });
        }

        res.json({ success: true, message: "Properties updated successfully" });

    } catch (err) {
        console.error("Error saving properties:", err);
        res.status(500).json({ error: "Internal Server Error" });
    } finally {
        if (connection) connection.release();
    }
}


async function surveyStatus(req, res) {
    let connection;
    try {
        const { connectionId, status } = req.body;

        if (!connectionId || !status) {
            return res.status(400).json({
                success: false,
                message: "connectionId and status are required"
            });
        }

        connection = await pool.getConnection();

        const query = `
            UPDATE connections
            SET status = ?
            WHERE id = ?
        `;

        const [result] = await connection.query(query, [status, connectionId]);

        if (result.affectedRows === 0) {
            return res.status(404).json({
                success: false,
                message: "No connection found with given ID"
            });
        }

        res.json({
            success: true,
            message: `Status updated to '${status}' for connection ${connectionId}`
        });
    } catch (error) {
        console.error("Error updating status:", error);
        res.status(500).json({
            success: false,
            message: "Error updating status",
            error: error.message
        });
    } finally {
        if (connection) connection.release();
    }
}

async function verifynetwok(req, res) {
    let connection;
    try {
        let networkId = req.body.networkId
        if (!networkId) throw new Error('Missing required field: networkId')
        connection = await pool.getConnection();;
        await connection.beginTransaction();
        await connection.execute('UPDATE networks SET status = ? WHERE id = ?', ['verified', networkId]);

        await connection.commit();
        res.json({ success: true, networkId, message: 'Block status Verified' });

    } catch (err) {
        if (connection) await connection.rollback();
        console.error('Error saving to database:', {
            message: err.message,
            stack: err.stack,
        });
        res.status(500).json({ success: false, details: err.message });
    } finally {
        if (connection) connection.release();
    }

}



async function getverifiednetworks(req, res) {
    let connection;
    try {
        // pagination params
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 15;
        const offset = (page - 1) * limit;

        // filters
        const { st_code, dt_code, blk_code } = req.query;

        const conditions = ["status = ?"];
        const params = ["verified"];

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

        const whereClause = `WHERE ${conditions.join(" AND ")}`;

        connection = await pool.getConnection();

        // total count
        const [countResult] = await connection.query(
            `SELECT COUNT(*) AS total FROM networks ${whereClause}`,
            params
        );
        const totalRows = countResult[0].total;
        const totalPages = Math.ceil(totalRows / limit);

        // paginated data
        const [rows] = await connection.query(
            `SELECT * FROM networks ${whereClause} ORDER BY id DESC LIMIT ? OFFSET ?`,
            [...params, limit, offset]
        );

        res.status(200).json({
            success: true,
            message: "Verified networks retrieved successfully",
            pagination: {
                currentPage: page,
                totalPages,
                totalRows,
                limit
            },
            filters: { st_code, dt_code, blk_code },
            data: rows
        });

    } catch (err) {
        console.error("Error fetching verified networks:", err);
        res.status(500).json({
            success: false,
            message: "Failed to retrieve networks",
            error: err.message
        });
    } finally {
        if (connection) connection.release?.();
    }
}


async function getconnections(req, res) {
    let connection;
    try {

        const { fromname, from_lgd, toName, to_lgd } = req.query;
        if (!fromname || !from_lgd || !toName || !to_lgd) throw new Error('Please Provide start and end Gps');

        // Connect to MySQL
        connection = await pool.getConnection();;
        await connection.beginTransaction();



        const [fromPoints] = await connection.query('SELECT * FROM points WHERE lgd_code = ?', [from_lgd]);
        if (fromPoints.length === 0) {
            throw new Error('No point found with the given from coordinates');
        }

        const [toPoints] = await connection.query('SELECT * FROM points WHERE lgd_code = ?', [to_lgd]);
        if (toPoints.length === 0) {
            throw new Error('No point found with the given to coordinates');
        }

        if (fromPoints[0].network_id !== toPoints[0].network_id) {
            throw new Error('Both points do not belong to the same network block');
        }
        const networkId = fromPoints[0].network_id;


        const [connections] = await connection.query('SELECT * FROM connections WHERE network_id = ?', [networkId]);
        if (connections.length === 0) {
            throw new Error('No connections found for the given network ID');
        }
        // Find matching polyline
        let polyline = [];
        let type
        for (let i = 0; i < connections.length; i++) {
            const startLatLong = connections[i].start_latlong;
            const endLatLong = connections[i].end_latlong;

            if (startLatLong === from_lgd && endLatLong === to_lgd) {
                type =
                    polyline.push(connections[i]);
            }
        }

        if (polyline.length === 0) {
            throw new Error('No matching connection found between the given points');
        }



        // Commit transaction
        await connection.commit();

        res.status(200).json({
            success: true,
            data: {
                polyline
            },
            message: 'Network data retrieved successfully'
        });



    } catch (err) {
        console.error('Error retrieving connection:', {
            message: err.message,
            stack: err.stack,
        });
        res.status(404).json({ success: false, details: err.message });
    } finally {
        if (connection) connection.release();
    }
};



async function assignsegmnets(req, res) {
    let connection;
    try {

        const { connectionId, user_id, user_name } = req.body;

        if (!connectionId || !user_id || !user_name) throw new Error('Missing required field: connectionId, user_id, user_name')
        connection = await pool.getConnection();;
        await connection.beginTransaction();
        const [updateResult] = await connection.execute(
            'UPDATE connections SET user_id = ?, user_name = ?, status = ? WHERE id = ?',
            [user_id, user_name, "assigned", connectionId]
        );

        // Check if any rows were affected
        if (updateResult.affectedRows === 0) {
            await connection.rollback();
            return res.status(404).json({ error: 'Connection not found' });
        }
        await connection.commit();
        res.json({ success: true, connectionId, message: 'Block status Verified' });

    } catch (err) {
        if (connection) await connection.rollback();
        console.error('Error saving to database:', {
            message: err.message,
            stack: err.stack,
        });
        res.status(500).json({ success: false, details: err.message });
    } finally {
        if (connection) connection.release();
    }
}

async function getnetworkId(req, res) {
    let connection;
    try {
        const networkId = parseInt(req.params.id);
        if (isNaN(networkId) || networkId <= 0) {
            return res.status(400).json({
                success: false,
                message: 'Invalid network ID'
            });
        }

        connection = await pool.getConnection();;
        await connection.beginTransaction();

        // Check if network exists
        const [networkRows] = await connection.query('SELECT * FROM networks WHERE id = ?', [networkId]);
        if (networkRows.length === 0) {
            return res.status(404).json({
                success: false,
                message: `Network with ID ${networkId} not found`
            });
        }

        // Fetch points
        const [points] = await connection.query('SELECT * FROM points WHERE network_id = ?', [networkId]);

        // Fetch connections
        const [connections] = await connection.query('SELECT * FROM connections WHERE network_id = ?', [networkId]);

        res.status(200).json({
            success: true,
            data: {
                network: networkRows[0],
                points,
                connections
            },
            message: 'Network data retrieved successfully'
        });
    } catch (err) {
        console.error('Error fetching network data:', {
            message: err.message,
            code: err.code,
            stack: err.stack
        });
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve network data',
            error: err.message
        });
    } finally {
        if (connection) {
            connection.release?.();
        }
    }
};


async function getgplist(req, res) {
    let connection;
    try {
        const networkId = parseInt(req.params.id);
        if (isNaN(networkId) || networkId <= 0) {
            return res.status(400).json({
                success: false,
                message: 'Invalid network ID'
            });
        }

        connection = await pool.getConnection();;
        await connection.beginTransaction();

        // Check if network exists
        const [networkRows] = await connection.query('SELECT * FROM networks WHERE id = ?', [networkId]);
        if (networkRows.length === 0) {
            return res.status(404).json({
                success: false,
                message: `Network with ID ${networkId} not found`
            });
        }


        // Fetch connections
        const [connections] = await connection.query(
            `SELECT 
                c.*, 
                u.fullname AS user_name
            FROM connections c
            LEFT JOIN users u ON c.user_id = u.id
            WHERE c.network_id = ?`,
            [networkId]
            );
        res.status(200).json({
            success: true,
            data: {
                connections
            },
            message: 'Network data retrieved successfully'
        });
    } catch (err) {
        console.error('Error fetching network data:', {
            message: err.message,
            code: err.code,
            stack: err.stack
        });
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve network data',
            error: err.message
        });
    } finally {
        if (connection) {
            connection.release?.();
        }
    }
};


async function updateConnection(req, res) {
    let connection;
    try {
        const connectionId = parseInt(req.params.id);
        if (isNaN(connectionId) || connectionId <= 0) {
            return res.status(400).json({
                success: false,
                message: "Invalid connection ID"
            });
        }

        // Extract fields from request body
        const {
            network_id,
            start_point_id,
            end_point_id,
            start,
            end,
            length,
            original_name,
            coordinates,
            type,
            color,
            start_latlong,
            end_latlong,
            user_id,
            user_name,
            status,
            properties
        } = req.body;

        connection = await pool.getConnection();
        await connection.beginTransaction();

        // Update query (only fields provided will be updated)
        const [result] = await connection.query(
            `
            UPDATE connections 
            SET 
                network_id = COALESCE(?, network_id),
                start_point_id = COALESCE(?, start_point_id),
                end_point_id = COALESCE(?, end_point_id),
                start = COALESCE(?, start),
                end = COALESCE(?, end),
                length = COALESCE(?, length),
                original_name = COALESCE(?, original_name),
                coordinates = COALESCE(?, coordinates),
                type = COALESCE(?, type),
                color = COALESCE(?, color),
                start_latlong = COALESCE(?, start_latlong),
                end_latlong = COALESCE(?, end_latlong),
                user_id = COALESCE(?, user_id),
                user_name = COALESCE(?, user_name),
                status = COALESCE(?, status),
                properties = COALESCE(?, properties)
            WHERE id = ?
            `,
            [
                network_id,
                start_point_id,
                end_point_id,
                start,
                end,
                length,
                original_name,
                coordinates,
                type,
                color,
                start_latlong,
                end_latlong,
                user_id,
                user_name,
                status,
                properties,
                connectionId
            ]
        );

        await connection.commit();

        if (result.affectedRows === 0) {
            return res.status(404).json({
                success: false,
                message: `Connection with ID ${connectionId} not found`
            });
        }

        res.status(200).json({
            success: true,
            message: "Connection updated successfully",
            connection_id: connectionId
        });

    } catch (err) {
        if (connection) await connection.rollback();
        console.error("Error updating connection:", err);
        res.status(500).json({
            success: false,
            message: "Failed to update connection",
            error: err.message
        });
    } finally {
        if (connection) connection.release?.();
    }
}

async function getuserlist(req, res) {
    let connection;
    try {
        
        connection = await pool.getConnection();;
        await connection.beginTransaction();

        const [usersList] = await connection.query('SELECT id, company_id, fullname,  email, contact_no FROM users WHERE is_active = 1');
        if (usersList.length === 0) {
            throw new Error('No connections found for the given network ID');
        }
        res.status(200).json({
            success: true,
            data: {
                usersList
            },
            message: 'users data retrieved successfully'
        });

    } catch (err) {
        console.error('Error retrieving connection:', {
            message: err.message,
            stack: err.stack,
        });
        res.status(404).json({ success: false, details: err.message });
    } finally {
        if (connection) connection.release();
    }
}


async function getassignedsegmnets(req, res) {
    let connection;
    try {
        let userid = req.params.id;
        if (!userid) return res.status(400).json({ success: false, details: "Please provide UserId" });

        connection = await pool.getConnection();
        await connection.beginTransaction();

        // Fetch connections for user
        const [connections] = await connection.query(
            'SELECT * FROM connections WHERE user_id = ?',
            [userid]
        );
        if (connections.length === 0) {
            throw new Error('No connections found for the given User ID');
        }

        // ---- Loop over connections & attach details ----
        for (let i = 0; i < connections.length; i++) {
            // Parse coordinates
            if (connections[i].coordinates) {
                try {
                    connections[i].coordinates = JSON.parse(connections[i].coordinates);
                } catch {
                    connections[i].coordinates = [];
                }
            }

            // Start & End gps points
            const [startPoint] = await connection.query(
                'SELECT * FROM gpslist WHERE lgd_code = ?',
                [connections[i].start_latlong]
            );
            const [endPoint] = await connection.query(
                'SELECT * FROM gpslist WHERE lgd_code = ?',
                [connections[i].end_latlong]
            );

            connections[i].start_coordinates = startPoint.length > 0 ? startPoint[0] : null;
            connections[i].end_coordinates = endPoint.length > 0 ? endPoint[0] : null;

            // ---- Get Network details for this connection ----
            if (connections[i].network_id) {
                const [network] = await connection.query(
                    'SELECT id, name, st_code, st_name, dt_code, dt_name, blk_code, blk_name FROM networks WHERE id = ?',
                    [connections[i].network_id]
                );

                if (network.length > 0) {
                    connections[i].network = network[0];

                    // Also fetch states/districts/blocks for this network
                    const [stateRes] = await connection.query(
                        'SELECT * FROM states WHERE state_code = ?',
                        [network[0].st_code]
                    );
                    const [districtRes] = await connection.query(
                        'SELECT * FROM districts WHERE district_code = ?',
                        [network[0].dt_code]
                    );
                    const [blockRes] = await connection.query(
                        'SELECT * FROM blocks WHERE block_code = ?',
                        [network[0].blk_code]
                    );

                    connections[i].state = stateRes.length > 0 ? stateRes[0] : null;
                    connections[i].district = districtRes.length > 0 ? districtRes[0] : null;
                    connections[i].block = blockRes.length > 0 ? blockRes[0] : null;
                }
            }
        }

        await connection.commit();

        res.status(200).json({
            success: true,
            data: { connections },
            message: 'Assigned segments data retrieved successfully'
        });

    } catch (error) {
        if (connection) await connection.rollback();
        console.error('Error:', error.message);
        res.status(500).json({ error: 'Failed to get the assigned segments', details: error.message });
    } finally {
        if (connection) connection.release();
    }
}



async function updtaenetwork(req, res) {
    let connection;
    try {
        const networkId = parseInt(req.params.networkId);
        if (isNaN(networkId)) {
            throw new Error('Invalid networkId: Must be a number');
        }

        const { globalData, polylineHistory, user_id, user_name } = req.body;
        if (
            !globalData ||
            !globalData.loop ||
            !globalData.mainPointName ||
            !polylineHistory ||
            !user_id ||
            !user_name ||
            !globalData.dt_code ||
            !globalData.dt_name ||
            !globalData.st_code ||
            !globalData.st_name
        ) {
            throw new Error('Missing required fields: globalData.loop, globalData.mainPointName, polylineHistory, user_id, user_name, dt_code, dt_name, st_code, or st_name');
        }

        // Connect to MySQL
        connection = await pool.getConnection();;
        await connection.beginTransaction();

        // Verify network exists
        const [networkRows] = await connection.execute('SELECT id FROM networks WHERE id = ?', [networkId]);
        if (networkRows.length === 0) {
            throw new Error(`Network with id ${networkId} not found`);
        }

        // Delete existing points and connections
        await connection.execute('DELETE FROM points WHERE network_id = ?', [networkId]);
        await connection.execute('DELETE FROM connections WHERE network_id = ?', [networkId]);

        // Calculate lengths
        let totalLength = globalData.totalLength || 0;
        let existingLength = globalData.existinglength || 0;
        let proposedLength = globalData.proposedlength || 0;

        if (totalLength === 0 || existingLength === 0 || proposedLength === 0) {
            for (const [, data] of Object.entries(polylineHistory)) {
                if (data.segmentData?.connection?.length) {
                    totalLength += data.segmentData.connection.length;
                    if (data.segmentData.connection.existing) {
                        existingLength += data.segmentData.connection.length;
                    } else {
                        proposedLength += data.segmentData.connection.length;
                    }
                }
            }
        }

        // Update networks
        const networkName = globalData.mainPointName;
        await connection.execute(
            'UPDATE networks SET name = ?, total_length = ?, main_point_name = ?, existing_length = ?, proposed_length = ?, dt_code = ?, dt_name = ?, st_code = ?, st_name = ?, user_id = ?, user_name = ?, status = ? WHERE id = ?',
            [
                networkName,
                totalLength,
                normalizeName(networkName),
                existingLength,
                proposedLength,
                globalData.dt_code,
                globalData.dt_name,
                globalData.st_code,
                globalData.st_name,
                user_id,
                user_name,
                'verified',
                networkId,
            ]
        );

        // Insert new points
        const uniquePoints = new Set();
        for (const point of globalData.loop) {
            if (!point.name || !point.coordinates) {
                console.warn(`Skipping point: Invalid name or coordinates`, point);
                continue;
            }
            const normalizedName = normalizeName(point.name);
            if (!uniquePoints.has(normalizedName)) {
                uniquePoints.add(normalizedName);
                const coords = normalizeCoordinates(point.coordinates);
                if (!coords || coords[0] === null || coords[1] === null) {
                    console.warn(`Skipping point: Invalid coordinates for ${normalizedName}`, point.coordinates);
                    continue;
                }
                await connection.execute(
                    'INSERT INTO points (network_id, name, coordinates, lgd_code) VALUES (?, ?, ?, ?)',
                    [networkId, normalizedName, JSON.stringify(coords), point.lgd_code || normalizedName]
                );
            }
        }

        // Insert new connections
        for (const [key, data] of Object.entries(polylineHistory)) {
            const match = key.match(/^(.+?)\s+TO\s+(.+)$/);
            if (!match) {
                console.warn(`Skipping polylineHistory entry: Invalid key format: ${key}`);
                continue;
            }
            let [start, end] = match.slice(1).map(normalizeName);

            let coordinates = [];
            if (data.polyline && Array.isArray(data.polyline)) {
                coordinates = data.polyline;
            } else if (data.polyline?.coordinates) {
                coordinates = data.polyline.coordinates;
            } else if (data.route?.features?.[0]?.geometry?.coordinates) {
                coordinates = data.route.features[0].geometry.coordinates;
            }

            coordinates = roundCoordinates(coordinates.map(c => (Array.isArray(c) ? c : [c.lng, c.lat])));
            if (!isValidLineString(coordinates)) {
                console.warn(`Skipping connection ${key}: Invalid coordinates`);
                continue;
            }

            const length = data.segmentData?.connection?.length || (coordinates.length >= 2 ? calculateDistance(coordinates[0], coordinates[coordinates.length - 1]) : 0);
            const color = data.segmentData?.connection?.color || '#000000';
            const type = data.segmentData?.connection?.existing ? 'existing' : 'proposed';
            const startLatLong = data.segmentData?.startCords;
            const endLatLong = data.segmentData?.endCords;

            if (!startLatLong || !endLatLong) {
                console.warn(`Skipping connection ${key}: Invalid startCords or endCords`);
                continue;
            }

            await connection.execute(
                'INSERT INTO connections (network_id, start, end, length, original_name, coordinates, color, start_latlong, end_latlong, type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [networkId, start, end, length, key, JSON.stringify(coordinates), color, startLatLong, endLatLong, type]
            );
        }

        await connection.commit();
        res.json({ success: true, networkId, message: `Network ${networkId} updated successfully` });
    } catch (err) {
        if (connection) await connection.rollback();
        console.error('Error updating network:', {
            message: err.message,
            stack: err.stack,
        });
        res.status(500).json({ success: false, details: err.message });
    } finally {
        if (connection) connection.release();
    }
};



async function deletenetwork(req, res) {
    let connection;
    try {
        const networkId = parseInt(req.params.networkId);
        if (isNaN(networkId)) {
            throw new Error('Invalid networkId: Must be a number');
        }

        // Get connection from pool
        connection = await pool.getConnection();;
        await connection.beginTransaction();

        // Verify network exists
        const [networkRows] = await connection.execute('SELECT id FROM networks WHERE id = ?', [networkId]);
        if (networkRows.length === 0) {
            throw new Error(`Network with id ${networkId} not found`);
        }

        // Delete from connections, points, and networks
        await connection.execute('DELETE FROM connections WHERE network_id = ?', [networkId]);
        await connection.execute('DELETE FROM points WHERE network_id = ?', [networkId]);
        await connection.execute('DELETE FROM networks WHERE id = ?', [networkId]);

        await connection.commit();
        res.json({ success: true, networkId, message: `Network ${networkId} deleted successfully` });
    } catch (err) {
        if (connection) await connection.rollback();
        console.error('Error deleting network:', {
            message: err.message,
            stack: err.stack,
        });
        res.status(500).json({ success: false, details: err.message });
    } finally {
        if (connection) connection.release();
    }
};

async function upload(req, res) {
    let connection;
    try {
        // Validate file uploads

        if (!req.files['pointsFile'] || !req.files['connectionsFile']) {
            throw new Error('Both points and connections files are required.');
        }

        const pointsPath = req.files['pointsFile'][0].path;
        const connectionsPath = req.files['connectionsFile'][0].path;
        const pointsKmlData = fs.readFileSync(pointsPath, 'utf8');
        const connectionsKmlData = fs.readFileSync(connectionsPath, 'utf8');
        const pointsKml = new DOMParser().parseFromString(pointsKmlData, 'text/xml');
        const connectionsKml = new DOMParser().parseFromString(connectionsKmlData, 'text/xml');
        const pointsGeoJson = toGeoJSON.kml(pointsKml);
        const connectionsGeoJson = toGeoJSON.kml(connectionsKml);

        // Points parsing (aligned with /upload-points)
        const rawPoints = new Map();
        const blockRouterFeature = pointsGeoJson.features.find(f => {
            const props = f.properties || {};
            const rawDesc = props.description || '';
            const typeFromExtended = props['type'] || props['ExtendedData']?.type;
            return (
                (typeof rawDesc === 'string' && rawDesc.toLowerCase().includes('block router')) ||
                (typeof typeFromExtended === 'string' && typeFromExtended.toLowerCase() === 'block router')
            );
        });

        let mainPointName = blockRouterFeature?.properties?.name;
        if (!mainPointName) throw new Error('âŒ Main point (Block Router) not found.');
        console.log('âœ… Detected Main Point:', mainPointName);
        let pointsWithoutLgd = [];
        pointsGeoJson.features.forEach(feature => {
            if (feature.geometry.type === 'Point') {
                let name = feature.properties.name?.trim() || '';
                name = normalizeName(name);
                const coordinates = roundCoordinates([feature.geometry.coordinates])[0];
                const properties = { ...feature.properties };
                delete properties.description;
                if (properties.ExtendedData) {
                    Object.entries(properties.ExtendedData).forEach(([key, value]) => {
                        properties[key] = value === 'NULL' ? null : value;
                    });
                    delete properties.ExtendedData;
                }

                // Check for LGD code
                const lgdCode = properties.lgd_code || properties.LGDCode || properties.lgd; // Adjust key name(s) as needed
                if (!lgdCode || lgdCode === 'NULL' || lgdCode === '') {
                    pointsWithoutLgd.push(name || 'Unnamed Point');
                }

                if (!rawPoints.has(name)) {
                    rawPoints.set(name, {
                        name,
                        coordinates,
                        properties,
                        styleUrl: feature.properties.styleUrl || null,
                    });
                }
            }
        });

        if (pointsWithoutLgd.length > 0) {
            throw new Error(`âŒ The following points are missing LGD codes: ${pointsWithoutLgd.join(', ')}`);
        }

        globalPoints = Array.from(rawPoints.values());

        // Connections parsing (aligned with /upload-connections)
        const pointMap = new Map(globalPoints.map(p => [p.name, p]));
        const connections = [];

        connectionsGeoJson.features.forEach(feature => {
            if (feature.geometry.type === 'LineString') {
                const name = feature.properties.name?.trim() || '';
                const toIndex = name.toLowerCase().lastIndexOf(' to ');
                if (toIndex === -1) {
                    console.warn(`âŒ Skipping: Invalid route name: ${name}`);
                    return;
                }

                let startName = normalizeName(name.substring(0, toIndex).trim());
                let endName = normalizeName(name.substring(toIndex + 4).trim());
                const coordinates = roundCoordinates(feature.geometry.coordinates);
                if (!isValidLineString(coordinates)) {
                    console.warn(`âŒ Skipping: Invalid LineString for ${startName} to ${endName}`);
                    return;
                }

                const startPoint = pointMap.get(startName) || pointMap.get(startName.replace(/\s+/g, '-')) || pointMap.get(startName.replace(/-/g, ' '));
                const endPoint = pointMap.get(endName) || pointMap.get(endName.replace(/\s+/g, '-')) || pointMap.get(endName.replace(/-/g, ' '));

                if (!startPoint || !endPoint) {
                    console.warn(`âŒ Skipping: No matching points for ${startName} to ${endName}`);
                    return;
                }

                const length =
                    parseFloat(
                        feature.properties.len ||
                        feature.properties.length ||
                        feature.properties['Data.length'] ||
                        0
                    ) || calculateDistance(startPoint.coordinates, endPoint.coordinates);

                let color = '#28a745';
                const rgbColor = feature.properties.LINE_COLOR?.match(/RGB\((\d+),(\d+),(\d+)\)/);
                if (rgbColor) {
                    const [, r, g, b] = rgbColor;
                    color = `#${parseInt(r).toString(16).padStart(2, '0')}${parseInt(g).toString(16).padStart(2, '0')}${parseInt(b).toString(16).padStart(2, '0')}`;
                }

                connections.push({
                    start: startName,
                    end: endName,
                    length,
                    name: feature.properties.name || `${startName} to ${endName}`,
                    coordinates: coordinates.map(([lng, lat]) => [lng, lat]),
                    color,
                    existing: true,
                });
            }
        });

        // Graph construction and route generation
        const pointMapFinal = new Map(rawPoints);
        const points = Array.from(rawPoints.values());
        const graph = {};
        points.forEach(p => (graph[p.name] = []));

        connections.forEach(({ start, end, length, name }) => {
            const startPoint = pointMapFinal.get(start);
            const endPoint = pointMapFinal.get(end);
            if (!startPoint || !endPoint) {
                console.warn(`ðŸš« No match for: ${name}`);
                return;
            }
            if (startPoint.name === endPoint.name) return;
            graph[startPoint.name].push({ to: endPoint.name, length, existing: true });
            graph[endPoint.name].push({ to: startPoint.name, length, existing: true });
        });

        points.forEach(p1 => {
            points.forEach(p2 => {
                if (p1 === p2) return;
                const already = graph[p1.name].some(e => e.to === p2.name);
                if (!already) {
                    const dist = calculateDistance(p1.coordinates, p2.coordinates);
                    graph[p1.name].push({ to: p2.name, length: dist, existing: false });
                }
            });
        });


        //const normalizedMainName = normalizeName(mainPointName);
        if (mainPointName) {

    const normalizedMainName = normalizeName(mainPointName);
    mainPoint = pointMapFinal.get(normalizedMainName);
}

        if (!mainPoint) {
            // Pick a random point from pointMapFinal
            const allPoints = Array.from(pointMapFinal.values());
            if (allPoints.length > 0) {
                mainPoint = allPoints[Math.floor(Math.random() * allPoints.length)];
                console.warn(`Main point "${mainPointName}" not found. Using random point: ${mainPoint.name}`);
            } else {
                console.error("pointMapFinal is empty! No points available.");
                mainPoint = null;
            }
        }
        const visited = new Set([mainPoint.name]);
        const loop = [{ ...mainPoint, connection: null, route: null }];
        const polylineHistory = {};
        let current = mainPoint;
        let existingLength = 0;
        let proposedLength = 0;

        while (visited.size < points.length) {
            const neighbors = graph[current.name]
                .filter(edge => !visited.has(edge.to))
                .sort((a, b) => {
                    if (a.existing && !b.existing) return -1;
                    if (!a.existing && b.existing) return 1;
                    return a.length - b.length;
                });

            if (neighbors.length === 0) break;

            const nextEdge = neighbors[0];
            const nextPoint = pointMapFinal.get(nextEdge.to);
            visited.add(nextPoint.name);

            const routeData = await getRoute(current.coordinates.slice(0, 2), nextPoint.coordinates.slice(0, 2));

            let color = '#28a745';
            if (!nextEdge.existing) {
                color = '#00FFFF';
                proposedLength += nextEdge.length;
            } else {
                existingLength += nextEdge.length;
            }

            const connection = {
                from: current.name,
                to: nextPoint.name,
                length: nextEdge.length,
                existing: nextEdge.existing,
                color,
            };

            loop.push({
                ...nextPoint,
                connection,
                route: routeData || null,
            });

            // Add to polylineHistory
            const connectionName = `${current.name} TO ${nextPoint.name}`.toUpperCase();
            const polylineCoordinates = routeData
                ? routeData.features[0].geometry.coordinates.map(([lng, lat]) => ({ lat, lng }))
                : [{ lat: current.coordinates[1], lng: current.coordinates[0] }, { lat: nextPoint.coordinates[1], lng: nextPoint.coordinates[0] }];

            polylineHistory[connectionName] = {
                polyline: {
                    coordinates: polylineCoordinates,
                },
                segmentData: {
                    connection: {
                        length: nextEdge.length,
                        existing: nextEdge.existing,
                        color,
                    },
                    startCords: current.properties.lgd_code || current.name,
                    endCords: nextPoint.properties.lgd_code || nextPoint.name,
                },
            };

            current = nextPoint;
        }

        // Close the loop
        const lastPoint = loop[loop.length - 1];
        const closingRoute = await getRoute(lastPoint.coordinates, mainPoint.coordinates);
        let closingLength, closingColor;

        if (closingRoute) {
            closingLength = closingRoute.features[0].properties.segments[0].distance / 1000;
            closingColor = '#00FFFF';
        } else {
            closingLength = calculateDistance(lastPoint.coordinates, mainPoint.coordinates);
            closingColor = '#00FFFF';
        }

        const closingExisting = connections.some(c =>
            (c.start === lastPoint.name && c.end === mainPoint.name) ||
            (c.start === mainPoint.name && c.end === lastPoint.name)
        );

        if (closingExisting) {
            closingColor = '#28a745';
            existingLength += closingLength;
        } else {
            proposedLength += closingLength;
        }

        const closingConnection = {
            from: lastPoint.name,
            to: mainPoint.name,
            length: closingLength,
            existing: closingExisting,
            color: closingColor,
        };

        loop.push({
            ...mainPoint,
            connection: closingConnection,
            route: closingRoute || null,
        });

        // Add closing connection to polylineHistory
        const closingConnectionName = `${lastPoint.name} TO ${mainPoint.name}`.toUpperCase();
        const closingPolylineCoordinates = closingRoute
            ? closingRoute.features[0].geometry.coordinates.map(([lng, lat]) => ({ lat, lng }))
            : [{ lat: lastPoint.coordinates[1], lng: lastPoint.coordinates[0] }, { lat: mainPoint.coordinates[1], lng: mainPoint.coordinates[0] }];

        polylineHistory[closingConnectionName] = {
            polyline: {
                coordinates: closingPolylineCoordinates,
            },
            segmentData: {
                connection: {
                    length: closingLength,
                    existing: closingExisting,
                    color: closingColor,
                },
                startCords: lastPoint.properties.lgd_code || lastPoint.name,
                endCords: mainPoint.properties.lgd_code || mainPoint.name,
            },
        };

        // Extract district and state info (hardcoded for example, or from properties)
        const districtStateInfo = {
            dt_code: '',
            dt_name: '',
            st_code: '',
            st_name: '',
        };
        // If available in properties, e.g.:
        const firstPointProps = points[0].properties;
        districtStateInfo.dt_code = firstPointProps.dt_code || '341';
        districtStateInfo.dt_name = firstPointProps.dt_name || 'HOWRAH';
        districtStateInfo.st_code = firstPointProps.st_code || '19';
        districtStateInfo.st_name = firstPointProps.st_name || 'WEST BENGAL';
        let mainPointNames = firstPointProps.blk_name
        // Format response
        const response = {
            globalData: {
                loop: loop.map(p => ({
                    name: p.name,
                    coordinates: p.coordinates,
                    lgd_code: p.properties.lgd_code || p.name,
                })),
                mainPointName: mainPointNames,
                totalLength: existingLength + proposedLength,
                proposedlength: proposedLength,
                existinglength: existingLength,
                ...districtStateInfo,
            },
            polylineHistory,
            user_id: 231, // Hardcoded per example; replace with req.body.user_id or auth data
            user_name: 'nikitha.m', // Hardcoded per example; replace with req.body.user_name or auth data
        };

        // Clean up uploaded files
        connection = await pool.getConnection();;
        await connection.beginTransaction();

        // Validate required fields
        if (
            !response.globalData ||
            !response.globalData.loop ||
            !response.globalData.mainPointName ||
            !response.polylineHistory ||
            !response.user_id ||
            !response.user_name ||
            !response.globalData.dt_code ||
            !response.globalData.dt_name ||
            !response.globalData.st_code ||
            !response.globalData.st_name
        ) {
            throw new Error('Missing required fields: globalData.loop, mainPointName, polylineHistory, user_id, user_name, dt_code, dt_name, st_code, or st_name');
        }

        // Insert into networks
        const networkName = response.globalData.mainPointName;
        const totalLength = response.globalData.totalLength;
        const extLength = response.globalData.existinglength;
        const proposedLengthDb = response.globalData.proposedlength;
        const dt_code = response.globalData.dt_code;
        const dt_name = response.globalData.dt_name;
        const st_code = response.globalData.st_code;
        const st_name = response.globalData.st_name;

        const [networkResult] = await connection.execute(
            'INSERT INTO networks (name, total_length, main_point_name, existing_length, proposed_length, dt_code, dt_name, st_code, st_name, user_id, user_name, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [
                networkName,
                totalLength,
                networkName,
                extLength,
                proposedLengthDb,
                dt_code,
                dt_name,
                st_code,
                st_name,
                response.user_id,
                response.user_name,
                'unverified',
            ]
        );
        const networkId = networkResult.insertId;

        // Insert unique points
        const uniquePoints = new Set();
        for (const point of response.globalData.loop) {
            if (!point.name || !point.coordinates) {
                console.warn(`Skipping point: Invalid name or coordinates`, point);
                continue;
            }
            const normalizedName = normalizeName(point.name);
            if (!uniquePoints.has(normalizedName)) {
                uniquePoints.add(normalizedName);
                const coords = roundCoordinates([point.coordinates])[0];
                if (!coords || coords[0] === null || coords[1] === null) {
                    console.warn(`Skipping point: Invalid coordinates for ${normalizedName}`, point.coordinates);
                    continue;
                }

                let flipcords = coords
                flipcords = [flipcords[1], flipcords[0]];


                await connection.execute(
                    'INSERT INTO points (network_id, name, coordinates, lgd_code) VALUES (?, ?, ?, ?)',
                    [networkId, normalizedName, JSON.stringify(flipcords), point.lgd_code || normalizedName]
                );
            }
        }

        // Insert connections from polylineHistory
        for (const [key, data] of Object.entries(response.polylineHistory)) {
            const match = key.match(/^(.+?)\s+TO\s+(.+)$/);
            if (!match) {
                console.warn(`Skipping polylineHistory entry: Invalid key format: ${key}`);
                continue;
            }
            let [start, end] = match.slice(1).map(normalizeName);

            let coordinates = data.polyline?.coordinates || [];
            coordinates = roundCoordinates(coordinates.map(c => [c.lat, c.lng]));
            if (!isValidLineString(coordinates)) {
                console.warn(`Skipping connection ${key}: Invalid coordinates`);
                continue;
            }

            const length = data.segmentData?.connection?.length || calculateDistance(coordinates[0], coordinates[coordinates.length - 1]);
            const color = data.segmentData?.connection?.color || '#000000';
            const type = data.segmentData?.connection?.existing ? 'existing' : 'proposed';
            const startLatLong = data.segmentData.startCords;
            const endLatLong = data.segmentData.endCords;

            if (!startLatLong || !endLatLong) {
                console.warn(`Skipping connection ${key}: Invalid startCords or endCords`);
                continue;
            }


            await connection.execute(
                'INSERT INTO connections (network_id, start, end, length, original_name, coordinates, color, start_latlong, end_latlong, type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [networkId, start, end, length, key, JSON.stringify(coordinates), color, startLatLong, endLatLong, type]
            );
        }

        await connection.commit();


        // Clean up uploaded files
        fs.unlinkSync(pointsPath);
        fs.unlinkSync(connectionsPath);

        //console.log(response, 'responseee');
        res.json({
            networkId, // Include networkId in response
        });
    } catch (err) {
        if (connection) await connection.rollback();
        console.error('âŒ Processing error:', {
            message: err.message,
            stack: err.stack,
        });

        res.status(500).json({ error: 'Failed to process KML files or save to database', details: err.message });
    } finally {
        if (connection) connection.release();
    }
};

async function generateRoute(req, res) {
    let connection;
    try {
        // Validate file upload
        if (!req.files['pointsFile']) {
            throw new Error('Points file is required.');
        }

        const pointsPath = req.files['pointsFile'][0].path;
        const pointsKmlData = fs.readFileSync(pointsPath, 'utf8');
        const pointsKml = new DOMParser().parseFromString(pointsKmlData, 'text/xml');
        const pointsGeoJson = toGeoJSON.kml(pointsKml);

        const rawPoints = new Map();

        // Points parsing
        const blockRouterFeature = pointsGeoJson.features.find(f => {
            const props = f.properties || {};
            const rawDesc = props.description || '';
            const typeFromExtended = props['type'] || props['ExtendedData']?.type;
            return (
                (typeof rawDesc === 'string' && rawDesc.toLowerCase().includes('block router')) ||
                (typeof typeFromExtended === 'string' && typeFromExtended.toLowerCase() === 'block router')
            );
        });

        let mainPointName = blockRouterFeature?.properties?.name;
        //if (!mainPointName) throw new Error('âŒ Main point (Block Router) not found.');
        console.log('âœ… Detected Main Point:', mainPointName);

        //console.log(JSON.stringify(pointsGeoJson))

        pointsGeoJson.features.forEach(feature => {
            if (feature.geometry.type === 'Point') {

                let name = (feature.properties && feature.properties.name)
                    ? feature.properties.name.trim()
                    : 'noname';
                name = normalizeName(name);
                console.log(name, "nameee, form down")
                const coordinates = roundCoordinates([feature.geometry.coordinates])[0];
                const properties = { ...feature.properties };
                delete properties.description;
                if (properties.ExtendedData) {
                    Object.entries(properties.ExtendedData).forEach(([key, value]) => {
                        properties[key] = value === 'NULL' ? null : value;
                    });
                    delete properties.ExtendedData;
                }

                if (!rawPoints.has(name)) {
                    rawPoints.set(name, {
                        name,
                        coordinates,
                        properties,
                        styleUrl: feature.properties.styleUrl || null,
                    });
                }
            }
        });
        const pointMapFinal = new Map(rawPoints);
        const points = Array.from(rawPoints.values());
        const graph = {};
        points.forEach(p => (graph[p.name] = []));

        // Generate edges based on distances
        points.forEach(p1 => {
            points.forEach(p2 => {
                if (p1 === p2) return;
                const dist = calculateDistance(p1.coordinates, p2.coordinates);
                graph[p1.name].push({ to: p2.name, length: dist, existing: false });
            });
        });

        let mainPoint = null;

            if (mainPointName) {
                const normalizedMainName = normalizeName(mainPointName);
                mainPoint = pointMapFinal.get(normalizedMainName);
            }

            if (!mainPoint) {
                // Pick a fallback point
                const allPoints = Array.from(pointMapFinal.values());
                if (allPoints.length > 0) {
                    mainPoint = allPoints[Math.floor(Math.random() * allPoints.length)];
                    console.warn(
                        `Main point "${mainPointName}" not found or undefined. Using fallback point: ${mainPoint.name}`
                    );
                } else {
                    console.error("pointMapFinal is empty! No points available.");
                }
            }

        const visited = new Set([mainPoint.name]);
        const loop = [{ ...mainPoint, connection: null, route: null }];
        const polylineHistory = {};
        let current = mainPoint;
        let proposedLength = 0;

        while (visited.size < points.length) {
            const neighbors = graph[current.name]
                .filter(edge => !visited.has(edge.to))
                .sort((a, b) => a.length - b.length);

            if (neighbors.length === 0) break;

            const nextEdge = neighbors[0];
            const nextPoint = pointMapFinal.get(nextEdge.to);
            visited.add(nextPoint.name);

            const routeData = await getRoute(current.coordinates.slice(0, 2), nextPoint.coordinates.slice(0, 2));

            const color = '#00FFFF'; // Match /upload for non-existing connections
            proposedLength += nextEdge.length;

            const connection = {
                from: current.name,
                to: nextPoint.name,
                length: nextEdge.length,
                existing: false,
                color,
            };

            loop.push({
                ...nextPoint,
                connection,
                route: routeData || null,
            });

            // Add to polylineHistory
            const connectionName = `${current.name} TO ${nextPoint.name}`.toUpperCase();
            const polylineCoordinates = routeData
                ? routeData.features[0].geometry.coordinates.map(([lng, lat]) => ({ lat, lng }))
                : [{ lat: current.coordinates[1], lng: current.coordinates[0] }, { lat: nextPoint.coordinates[1], lng: nextPoint.coordinates[0] }];

            polylineHistory[connectionName] = {
                polyline: {
                    coordinates: polylineCoordinates,
                },
                segmentData: {
                    connection: {
                        length: nextEdge.length,
                        existing: false,
                        color,
                    },
                    startCords: current.properties.lgd_code || current.name,
                    endCords: nextPoint.properties.lgd_code || nextPoint.name,
                },
            };

            current = nextPoint;
        }

        // Close the loop
        const lastPoint = loop[loop.length - 1];
        const closingRoute = await getRoute(lastPoint.coordinates, mainPoint.coordinates);
        let closingLength, closingColor;

        if (closingRoute) {
            closingLength = closingRoute.features[0].properties.segments[0].distance / 1000;
            closingColor = '#00FFFF';
        } else {
            closingLength = calculateDistance(lastPoint.coordinates, mainPoint.coordinates);
            closingColor = '#00FFFF';
        }

        proposedLength += closingLength;

        const closingConnection = {
            from: lastPoint.name,
            to: mainPoint.name,
            length: closingLength,
            existing: false,
            color: closingColor,
        };

        loop.push({
            ...mainPoint,
            connection: closingConnection,
            route: closingRoute || null,
        });

        // Add closing connection to polylineHistory
        const closingConnectionName = `${lastPoint.name} TO ${mainPoint.name}`.toUpperCase();
        const closingPolylineCoordinates = closingRoute
            ? closingRoute.features[0].geometry.coordinates.map(([lng, lat]) => ({ lat, lng }))
            : [{ lat: lastPoint.coordinates[1], lng: lastPoint.coordinates[0] }, { lat: mainPoint.coordinates[1], lng: mainPoint.coordinates[0] }];

        polylineHistory[closingConnectionName] = {
            polyline: {
                coordinates: closingPolylineCoordinates,
            },
            segmentData: {
                connection: {
                    length: closingLength,
                    existing: false,
                    color: closingColor,
                },
                startCords: lastPoint.properties.lgd_code || lastPoint.name,
                endCords: mainPoint.properties.lgd_code || mainPoint.name,
            },
        };

        // Extract district and state info
        const districtStateInfo = {
            dt_code: '',
            dt_name: '',
            st_code: '',
            st_name: '',
        };
        const firstPointProps = points[0].properties || {};
        districtStateInfo.dt_code = firstPointProps.dt_code || '341';
        districtStateInfo.dt_name = firstPointProps.dt_name || 'HOWRAH';
        districtStateInfo.st_code = firstPointProps.st_code || '19';
        districtStateInfo.st_name = firstPointProps.st_name || 'WEST BENGAL';
        let mainpoints = firstPointProps.blk_name
        // Format response to match /upload
        const response = {
            globalData: {
                loop: loop.map(p => ({
                    name: p.name,
                    coordinates: p.coordinates,
                    lgd_code: p.properties.lgd_code || p.name,
                })),
                mainPointName: mainpoints,
                totalLength: proposedLength,
                proposedlength: proposedLength,
                existinglength: 0, // All connections are non-existing
                ...districtStateInfo,
            },
            polylineHistory,
            user_id: 231, // Hardcoded; replace with req.body.user_id if dynamic
            user_name: 'nikitha.m', // Hardcoded; replace with req.body.user_name if dynamic
        };

        // Database Saving
        connection = await pool.getConnection();;
        await connection.beginTransaction();

        // Validate required fields
        if (
            !response.globalData ||
            !response.globalData.loop ||
            !response.globalData.mainPointName ||
            !response.polylineHistory ||
            !response.user_id ||
            !response.user_name ||
            !response.globalData.dt_code ||
            !response.globalData.dt_name ||
            !response.globalData.st_code ||
            !response.globalData.st_name
        ) {
            throw new Error('Missing required fields: globalData.loop, mainPointName, polylineHistory, user_id, user_name, dt_code, dt_name, st_code, or st_name');
        }

        // Insert into networks
        const networkName = response.globalData.mainPointName;
        const totalLength = response.globalData.totalLength;
        const extLength = response.globalData.existinglength;
        const proposedLengthDb = response.globalData.proposedlength;
        const dt_code = response.globalData.dt_code;
        const dt_name = response.globalData.dt_name;
        const st_code = response.globalData.st_code;
        const st_name = response.globalData.st_name;

        const [networkResult] = await connection.execute(
            'INSERT INTO networks (name, total_length, main_point_name, existing_length, proposed_length, dt_code, dt_name, st_code, st_name, user_id, user_name, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [
                networkName,
                totalLength,
                networkName,
                extLength,
                proposedLengthDb,
                dt_code,
                dt_name,
                st_code,
                st_name,
                response.user_id,
                response.user_name,
                'unverified',
            ]
        );
        const networkId = networkResult.insertId;

        // Insert unique points
        const uniquePoints = new Set();
        for (const point of response.globalData.loop) {
            if (!point.name || !point.coordinates) {
                console.warn(`Skipping point: Invalid name or coordinates`, point);
                continue;
            }
            const normalizedName = normalizeName(point.name);
            if (!uniquePoints.has(normalizedName)) {
                uniquePoints.add(normalizedName);
                const coords = roundCoordinates([point.coordinates])[0];
                if (!coords || coords[0] === null || coords[1] === null) {
                    console.warn(`Skipping point: Invalid coordinates for ${normalizedName}`, point.coordinates);
                    continue;
                }
                await connection.execute(
                    'INSERT INTO points (network_id, name, coordinates, lgd_code) VALUES (?, ?, ?, ?)',
                    [networkId, normalizedName, JSON.stringify(coords), point.lgd_code || normalizedName]
                );
            }
        }

        // Insert connections from polylineHistory
        for (const [key, data] of Object.entries(response.polylineHistory)) {
            const match = key.match(/^(.+?)\s+TO\s+(.+)$/);
            if (!match) {
                console.warn(`Skipping polylineHistory entry: Invalid key format: ${key}`);
                continue;
            }
            let [start, end] = match.slice(1).map(normalizeName);

            let coordinates = data.polyline?.coordinates || [];
            coordinates = roundCoordinates(coordinates.map(c => [c.lng, c.lat]));
            if (!isValidLineString(coordinates)) {
                console.warn(`Skipping connection ${key}: Invalid coordinates`);
                continue;
            }

            const length = data.segmentData?.connection?.length || calculateDistance(coordinates[0], coordinates[coordinates.length - 1]);
            const color = data.segmentData?.connection?.color || '#00FFFF';
            const type = 'proposed'; // All connections are non-existing
            const startLatLong = data.segmentData.startCords;
            const endLatLong = data.segmentData.endCords;

            if (!startLatLong || !endLatLong) {
                console.warn(`Skipping connection ${key}: Invalid startCords or endCords`);
                continue;
            }

            await connection.execute(
                'INSERT INTO connections (network_id, start, end, length, original_name, coordinates, color, start_latlong, end_latlong, type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [networkId, start, end, length, key, JSON.stringify(coordinates), color, startLatLong, endLatLong, type]
            );
        }

        await connection.commit();

        // Clean up uploaded file
        await fs.promises.unlink(pointsPath);

        res.json({
            networkId,
        });
    } catch (err) {
        if (connection) await connection.rollback();
        console.error('âŒ Generate route error:', {
            message: err.message,
            stack: err.stack,
        });

        res.status(500).json({ error: 'Failed to generate route, save to database, or save KML', details: err.message });
    } finally {
        if (connection) connection.release();
    }
};

async function searchlocation(req, res) {
    const { query } = req.query;
    if (!query) {
        return res.status(400).json({ error: 'Query parameter is required' });
    }

    try {
        const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&key=${googleMapsApiKey}`;
        const response = await axios.get(url);
        if (response.data.status !== 'OK') {
            return res.status(500).json({ error: `Google API error: ${response.data.status}` });
        }

        const results = response.data.results.map(place => ({
            name: place.name,
            formatted_address: place.formatted_address,
            location: {
                lat: place.geometry.location.lat,
                lng: place.geometry.location.lng,
            },
        }));

        res.json(results);
    } catch (error) {
        console.error('Search error:', error.message);
        res.status(500).json({ error: 'Failed to fetch search results' });
    }
};

async function downloadkml(req, res) {
    try {
        const { globalData, polylineHistory } = req.body;
        if (!globalData || !globalData.loop || !polylineHistory) {
            return res.status(400).json({ error: 'Missing required data' });
        }

        let kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
    <name>Tricad Route</name>
    <Style id="existingLine">
        <LineStyle>
            <color>ff00ff55</color>
            <width>4</width>
        </LineStyle>
    </Style>
    <Style id="proposedLine">
        <LineStyle>
            <color>ff0000ff</color>
            <width>4</width>
        </LineStyle>
    </Style>
    <Style id="mainPoint">
        <IconStyle>
            <Icon>
                <href>https://maps.google.com/mapfiles/kml/paddle/red-circle.png</href>
            </Icon>
        </IconStyle>
    </Style>
    <Style id="otherPoint">
        <IconStyle>
            <Icon>
                <href>https://maps.google.com/mapfiles/kml/paddle/blu-circle.png</href>
            </Icon>
        </IconStyle>
    </Style>
    <Style id="lengthLabel">
        <LabelStyle>
            <color>ffffffff</color>
            <scale>1.2</scale>
        </LabelStyle>
        <IconStyle>
            <scale>0</scale>
        </IconStyle>
    </Style>`;

        // Add points
        const uniquePoints = new Set();
        globalData.loop.forEach(point => {
            if (point.coordinates && point.coordinates.length >= 2 && !uniquePoints.has(point.name)) {
                uniquePoints.add(point.name);
                const isMainPoint = point.name === globalData.mainPointName;
                kml += `
    <Placemark>
        <name>${point.name}</name>
        <styleUrl>#${isMainPoint ? 'mainPoint' : 'otherPoint'}</styleUrl>
        <Point>
            <coordinates>${point.coordinates[0].toFixed(6)},${point.coordinates[1].toFixed(6)},0</coordinates>
        </Point>
    </Placemark>`;
            }
        });

        // Deduplicate lines
        const segmentMap = new Map();
        Object.entries(polylineHistory).forEach(([segmentKey, history]) => {
            if (history.polyline && history.polyline.coordinates) {
                // Normalize segmentKey by removing -routeX suffix
                const normalizedKey = segmentKey.replace(/-route\d+$/, '');
                const length = history.segmentData?.connection?.length || 0;
                const isExisting = history.segmentData?.connection?.existing || false;
                const coords = history.polyline.coordinates.map(coord => `${coord.lng.toFixed(6)},${coord.lat.toFixed(6)},0`).join(' ');

                // Keep the segment with the longest length
                if (!segmentMap.has(normalizedKey) || segmentMap.get(normalizedKey).length < length) {
                    segmentMap.set(normalizedKey, {
                        segmentKey: normalizedKey,
                        coords,
                        length,
                        isExisting,
                        coordinates: history.polyline.coordinates
                    });
                }
            }
        });

        // Add deduplicated lines and midpoint labels
        segmentMap.forEach(({ segmentKey, coords, length, isExisting, coordinates }) => {
            kml += `
    <Placemark>
        <name>${segmentKey}</name>
        <styleUrl>#${isExisting ? 'existingLine' : 'proposedLine'}</styleUrl>
        <ExtendedData>
            <Data name="length"><value>${length.toFixed(3)} km</value></Data>
            <Data name="existing"><value>${isExisting}</value></Data>
        </ExtendedData>
        <LineString>
            <coordinates>${coords}</coordinates>
        </LineString>
    </Placemark>`;
            const midpoint = getMidpoint(coordinates);
            if (midpoint) {
                kml += `
    <Placemark>
        <name>${length.toFixed(3)} km</name>
        <styleUrl>#lengthLabel</styleUrl>
        <Point>
            <coordinates>${midpoint.lng.toFixed(6)},${midpoint.lat.toFixed(6)},0</coordinates>
        </Point>
    </Placemark>`;
            }
        });

        kml += `
</Document>
</kml>`;

        res.set({
            'Content-Type': 'application/vnd.google-earth.kml+xml',
            'Content-Disposition': 'attachment; filename="routes.kml"',
        });
        res.send(kml);
    } catch (error) {
        console.error('KML download error:', error);
        res.status(500).json({ error: 'Failed to generate KML file', details: error.message });
    }
};
async function downloadcsv(req, res) {
    try {
        const { globalData, polylineHistory } = req.body;
        console.log(globalData, "global Data");
        console.log(polylineHistory, "polylineHistory");
        if (!globalData || !globalData.loop || !polylineHistory) {
            return res.status(400).json({ error: 'Missing required data' });
        }

        let csv = 'Type,Name,Longitude,Latitude,Length_km,Existing\n';
        globalData.loop.forEach(point => {
            if (point.coordinates && point.coordinates.length >= 2) {
                csv += `Point,${point.name},${point.coordinates[0]},${point.coordinates[1]},,\n`;
            }
        });

        // Deduplicate line segments
        const segmentMap = new Map();
        Object.entries(polylineHistory).forEach(([segmentKey, history]) => {
            if (history.polyline && history.polyline.coordinates) {
                // Normalize segmentKey by removing -routeX suffix
                const normalizedKey = segmentKey.replace(/-route\d+$/, '');
                let length = history.segmentData?.connection?.length || 0;
                if (length === 0) {
                    const [from, to] = normalizedKey.split('-');
                    const point = globalData.loop.find(p => p.connection?.from === from && p.connection?.to === to);
                    if (point?.connection?.length) {
                        length = point.connection.length;
                    }
                }
                const isExisting = history.segmentData?.connection?.existing || false;

                // Keep the segment with the longest length or most recent data
                if (!segmentMap.has(normalizedKey) || segmentMap.get(normalizedKey).length < length) {
                    segmentMap.set(normalizedKey, { segmentKey: normalizedKey, length, isExisting });
                }
            }
        });

        // Add deduplicated segments to CSV
        segmentMap.forEach(({ segmentKey, length, isExisting }) => {
            csv += `Line,${segmentKey},,,${length},${isExisting}\n`;
        });

        res.set({
            'Content-Type': 'text/csv',
            'Content-Disposition': 'attachment; filename="routes.csv"',
        });
        res.send(csv);
    } catch (error) {
        console.error('CSV download error:', error);
        res.status(500).json({ error: 'Failed to generate CSV file', details: error.message });
    }
};

function savekml(req, res) {
    const { globalData, polylineHistory } = req.body;


    // Validate input
    if (!globalData || !globalData.loop || !polylineHistory) {
        return res.status(400).json({ message: 'Missing required data' });
    }

    // Helper function to calculate midpoint

    // Generate KML
    let kml = `<?xml version="1.0" encoding="UTF-8"?>
  <kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
      <name>Tricad Route</name>
      <Style id="existingLine">
          <LineStyle>
              <color>ff00ff55</color>
              <width>4</width>
          </LineStyle>
      </Style>
      <Style id="proposedLine">
          <LineStyle>
              <color>ff0000ff</color>
              <width>4</width>
          </LineStyle>
      </Style>
      <Style id="mainPoint">
          <IconStyle>
              <Icon>
                  <href>https://maps.google.com/mapfiles/kml/paddle/red-circle.png</href>
              </Icon>
          </IconStyle>
      </Style>
      <Style id="otherPoint">
          <IconStyle>
              <Icon>
                  <href>https://maps.google.com/mapfiles/kml/paddle/blu-circle.png</href>
              </Icon>
          </IconStyle>
      </Style>
      <Style id="lengthLabel">
          <LabelStyle>
              <color>ffffffff</color>
              <scale>1.2</scale>
          </LabelStyle>
          <IconStyle>
              <scale>0</scale>
          </IconStyle>
      </Style>`;

    // Add points
    globalData.loop.forEach(point => {
        if (point.coordinates && point.coordinates.length >= 2) {
            const isMainPoint = point.name === globalData.mainPointName;
            kml += `
      <Placemark>
          <name>${point.name}</name>
          <styleUrl>#${isMainPoint ? 'mainPoint' : 'otherPoint'}</styleUrl>
          <Point>
              <coordinates>${point.coordinates[0]},${point.coordinates[1]},0</coordinates>
          </Point>
      </Placemark>`;
        }
    });

    // Add lines and midpoint labels
    Object.entries(polylineHistory).forEach(([segmentKey, history]) => {
        if (history.polyline && history.polyline.coordinates) {
            const coords = history.polyline.coordinates.map(coord => `${coord.lng},${coord.lat},0`).join(' ');
            const isExisting = history.segmentData?.connection?.existing || false;
            const length = history.segmentData?.connection?.length || 0;
            kml += `
      <Placemark>
          <name>${segmentKey}</name>
          <styleUrl>#${isExisting ? 'existingLine' : 'proposedLine'}</styleUrl>
          <ExtendedData>
              <Data name="length"><value>${length} km</value></Data>
              <Data name="existing"><value>${isExisting}</value></Data>
          </ExtendedData>
          <LineString>
              <coordinates>${coords}</coordinates>
          </LineString>
      </Placemark>`;
            const midpoint = getMidpoint(history.polyline.coordinates);
            if (midpoint) {
                kml += `
      <Placemark>
          <name>${length} km</name>
          <styleUrl>#lengthLabel</styleUrl>
          <Point>
              <coordinates>${midpoint.lng},${midpoint.lat},0</coordinates>
          </Point>
      </Placemark>`;
            }
        }
    });

    kml += `
  </Document>
  </kml>`;

    // Save KML to uploads folder
    const uploadsDir = path.join(__dirname, 'Uploads');
    const filename = `${globalData.mainPointName}_AUTO_Route.kml`;
    const filePath = path.join(uploadsDir, filename);

    // Create uploads folder if it doesn't exist
    fs.mkdir(uploadsDir, { recursive: true }, (err) => {
        if (err) {
            console.error('Error creating uploads directory:', err);
            return res.status(500).json({ message: 'Failed to create uploads directory', details: err.message });
        }

        // Write KML file
        fs.writeFile(filePath, kml, (err) => {
            if (err) {
                console.error('Error saving KML file:', err);
                return res.status(500).json({ message: 'Failed to save KML file', details: err.message });
            }

            res.status(200).json({
                message: 'KML saved successfully',
                filePath: `/Uploads/${filename}`,
            });
        });
    });
};

async function getunverifiednetwork(req, res) {
    let connection;
    try {
        connection = await pool.getConnection();;
        await connection.beginTransaction();
        const [rows] = await connection.query("SELECT * FROM networks WHERE status = ?", ["unverified"]);

        res.status(200).json({
            success: true,
            data: rows,
            message: 'Networks retrieved successfully'
        });
    } catch (err) {
        console.error('Error fetching networks:', {
            message: err.message,
            code: err.code,
            stack: err.stack
        });
        res.status(500).json({
            success: false,
            message: 'Failed to retrieve networks',
            error: err.message
        });
    } finally {
        if (connection) {
            connection.release?.();
        }
    }
};


function checkFileExists(filePath, callback) {
    fs.access(filePath, fs.constants.F_OK, (err) => {
        if (err) {
            console.log('File not found:', filePath);
            return callback(false);
        }
        console.log('File exists:', filePath);
        callback(true);
    });
}

// Preview KML file
function previewkml(req, res) {
    const { filename } = req.params;
    const uploadsDir = path.join(__dirname, 'Uploads');
    const filePath = path.join(uploadsDir, filename);

    checkFileExists(filePath, (exists) => {
        if (!exists) {
            return res.status(404).json({ message: 'KML file not found' });
        }

        fs.readFile(filePath, 'utf-8', (err, kmlContent) => {
            if (err) {
                console.error('Error reading KML file:', err);
                return res.status(500).json({ message: 'Failed to read KML file' });
            }
            res.status(200).send(kmlContent);
        });
    });
};




function haversineDistance(coords1, coords2) {
    const R = 6371e3; // Earth's radius in meters
    const lat1 = coords1[1] * Math.PI / 180;
    const lat2 = coords2[1] * Math.PI / 180;
    const deltaLat = (coords2[1] - coords1[1]) * Math.PI / 180; // Fixed typo
    const deltaLng = (coords2[0] - coords1[0]) * Math.PI / 180; // Fixed typo

    const a = Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
        Math.cos(lat1) * Math.cos(lat2) *
        Math.sin(deltaLng / 2) * Math.sin(deltaLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c; // Distance in meters
}

// Filter points to keep those at least 10 meters apart
function filterPointsByDistance(points, minDistance = 10) {
    if (!points.length) return [];
    const filtered = [points[0]]; // Keep first point
    for (let i = 1; i < points.length; i++) {
        let keep = true;
        for (const p of filtered) {
            if (haversineDistance(points[i].coordinates, p.coordinates) < minDistance) {
                keep = false;
                break;
            }
        }
        if (keep) filtered.push(points[i]);
    }
    return filtered;
}



async function uploadfilterpoints(req, res) {
    let pointsPath
    try {
        const pointsPath = req.file.path;
        const pointsKmlData = fs.readFileSync(pointsPath, 'utf8');
        const pointsKml = new DOMParser().parseFromString(pointsKmlData, 'text/xml');
        const pointsGeoJson = toGeoJSON.kml(pointsKml);

        const rawPoints = pointsGeoJson.features
            .filter(({ geometry }) => geometry?.type === 'Point')
            .map(({ geometry, properties }) => {
                const coordinates = geometry.coordinates.slice(0, 2);
                const name = (properties.name || 'Unnamed').trim().replace(/[^a-zA-Z0-9_-]/g, '_');
                const props = { ...properties };
                delete props.description;
                delete props.name;

                // Process ExtendedData
                if (props.ExtendedData) {
                    for (const [key, value] of Object.entries(props.ExtendedData)) {
                        props[key] = value === 'NULL' ? null : value;
                    }
                    delete props.ExtendedData;
                }

                return {
                    name,
                    coordinates,
                    properties: props,
                    styleUrl: props.styleUrl || null,
                };
            });

        if (!rawPoints.length) {
            return res.status(400).json({ error: 'No valid Point features found' });
        }

        // Filter points
        const filteredPoints = filterPointsByDistance(rawPoints, 10);

        res.json({ points: filteredPoints });
    } catch (err) {
        console.error('âŒ Filtered points processing error:', err);
        res.status(500).json({ error: 'Failed to process KML file', details: err.message });
    } finally {
        // Clean up file
        if (pointsPath) {
            try {
                await fs.unlink(pointsPath);
            } catch (unlinkErr) {
                console.error('âŒ Failed to delete temp file:', unlinkErr);
            }
        }
  
};
}

const GOOGLE_API_KEY = googleMapsApiKey;

// Endpoint to compute route
async function computeroute(req, res) {
    const { origin, destination, newPos } = req.body;

    // Validate input
    if (!origin || !destination || !origin.lat || !origin.lng || !destination.lat || !destination.lng) {
        return res.status(400).json({ error: 'origin and destination with lat/lng required' });
    }

    try {
        // Build Directions API URL
        let url = `https://maps.googleapis.com/maps/api/directions/json?origin=${origin.lat},${origin.lng}&destination=${destination.lat},${destination.lng}&key=${GOOGLE_API_KEY}&alternatives=true`;
        if (newPos && newPos.lat && newPos.lng) {
            url += `&waypoints=${newPos.lat},${newPos.lng}`;
        }

        const response = await axios.get(url);
        const data = response.data;

        // Check status
        if (data.status !== 'OK') {
            return res.status(500).json({ error: `Directions API failed: ${data.status}`, details: data.error_message });
        }

        const routes = data.routes;
        if (!routes || routes.length === 0) {
            return res.status(404).json({ error: 'No routes found' });
        }

        // Process routes (like your snippet)
        const result = routes
            .map(route => {
                const overviewPolyline = route.overview_polyline?.points;
                if (!overviewPolyline) return null;

                // Decode polyline to [[lat, lng], ...]
                const points = polyline.decode(overviewPolyline);

                // Sum distance in meters, convert to km
                let distance = 0;
                route.legs.forEach(leg => {
                    distance += leg.distance.value;
                });
                distance = distance / 1000; // Convert to km

                return { route: points, distance };
            })
            .filter(r => r !== null);

        // Check if any valid routes
        if (!result.length) {
            return res.status(404).json({ error: 'No valid routes found' });
        }

        // Send response
        res.json(result);
    } catch (error) {
        console.error('Error:', error.response?.data || error.message);
        res.status(500).json({ error: 'Failed to compute route', details: error.response?.data });
    }
};



async function getSurveysByUser(req, res) {
  let connection;

  try {
    const { user_id } = req.query;

    if (!user_id) {
      return res.status(400).json({
        status: false,
        error: "user_id is required"
      });
    }

    connection = await pool.getConnection();

    // 1?? Physical & Construction surveys
    const [surveyCounts] = await connection.query(
      `
      SELECT 
        COUNT(CASE WHEN surveyType IS NULL OR surveyType <> '1' THEN 1 END) AS physicalSurveyCount,
        COUNT(CASE WHEN surveyType = '1' THEN 1 END) AS constructionSurveyCount,
        COUNT(CASE WHEN is_active= 1 THEN 1 END) AS approvalCount
      FROM underground_fiber_surveys
      WHERE user_id = ?
      `,
      [user_id]
    );

    // 2?? GP Installation
    const [gpCounts] = await connection.query(
      `SELECT COUNT(*) AS gpInstallationCount 
       FROM gp_installation 
       WHERE user_id = ?`,
      [user_id]
    );

    // 3?? Block Installation
    const [blockCounts] = await connection.query(
      `SELECT COUNT(*) AS blockInstallationCount 
       FROM block_installation 
       WHERE user_id = ?`,
      [user_id]
    );

    // 4?? Links count from connections
    const [linkCounts] = await connection.query(
      `SELECT COUNT(*) AS linksCount
       FROM connections
       WHERE user_id = ?`,
      [user_id]
    );

    res.json({
      status: true,
      physicalSurveyCount: surveyCounts[0].physicalSurveyCount,
      constructionSurveyCount: surveyCounts[0].constructionSurveyCount,
      gpInstallationCount: gpCounts[0].gpInstallationCount,
      blockInstallationCount: blockCounts[0].blockInstallationCount,
        approvalCount: surveyCounts[0].approvalCount,
      linksCount: linkCounts[0].linksCount
    });

  } catch (err) {
    console.error("? API error:", err);
    res.status(500).json({
      status: false,
      error: err.message
    });
  } finally {
    if (connection) connection.release();
  }
}



async function insertUndergroundSurvey(req, res) {
  let connection;
  try {
    const {
      surveyId,
      areaType,
      eventType,
      surveyUploaded,
      executionModality,
      latitude,
      longitude,
      altitude,
      accuracy,
      depth,
      distance_error,
      patrollerDetails,
      roadCrossing,
      routeDetails,
      routeFeasibility,
      sideType,
      startPhotos,
      endPhotos,
      utilityFeaturesChecked,
      videoUrl,
      videoDetails,
      routeIndicatorUrl,
      routeIndicatorType,
      kmtStoneUrl,
      fiberTurnUrl,
      landMarkType,
      landMarkUrls,
      landMarkDescription,
      fpoiUrl,
      jointChamberUrl,
      createdTime
    } = req.body;

    if (!surveyId) {
      return res.status(400).json({
        success: false,
        message: "surveyId is required"
      });
    }

    connection = await pool.getConnection();

    const query = `
      INSERT INTO underground_survey_data (
        survey_id, area_type, event_type, surveyUploaded, fpoiUrl,
        execution_modality, latitude, longitude, altitude, accuracy,
        depth, distance_error, patroller_details, road_crossing,
        route_details, route_feasibility, side_type,
        start_photos, end_photos, utility_features_checked,
        videoUrl, videoDetails, routeIndicatorUrl, routeIndicatorType,
        kmtStoneUrl, fiberTurnUrl, landMarkType, landMarkDescription,
        landMarkUrls, jointChamberUrl, createdTime
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const values = [
      surveyId,
      areaType || null,
      eventType || null,
      surveyUploaded || "false",
      fpoiUrl || null,
      executionModality || null,
      latitude || null,
      longitude || null,
      altitude || 0,
      accuracy || 0,
      depth || 0,
      distance_error || 0,
      JSON.stringify(patrollerDetails || {"companyName":"","email":"","mobile":"","name":""} ),
      JSON.stringify(roadCrossing || {}),
      JSON.stringify(routeDetails || {}),
      JSON.stringify(routeFeasibility || {}),
      sideType || null,
      JSON.stringify(startPhotos || []),
      JSON.stringify(endPhotos || []),
      JSON.stringify(utilityFeaturesChecked || []),
      videoUrl ? JSON.stringify(videoUrl) : null,
      videoDetails ? JSON.stringify(videoDetails) : null,
      routeIndicatorUrl ? JSON.stringify(routeIndicatorUrl) : null,
      routeIndicatorType || null,
      kmtStoneUrl || null,
      fiberTurnUrl || null,
      landMarkType || null,
      landMarkDescription || null,
      landMarkUrls ? JSON.stringify(landMarkUrls) : null,
      jointChamberUrl || null,
      createdTime
        ? new Date(createdTime).toISOString().slice(0, 19).replace("T", " ")
        : null,
    ];

    const [result] = await connection.execute(query, values);

    res.status(201).json({
      success: true,
      message: "Survey data inserted successfully",
      inserted_id: result.insertId,
    });
  } catch (error) {
    console.error("Insert Underground Survey Error:", error);
    res.status(500).json({
      success: false,
      message: "Database error",
      error: error.message,
    });
  } finally {
    if (connection) connection.release();
  }
}



module.exports = { uploadPoints, uploadConnection, showRoute,getSurveysByUser, savetodb, verifynetwok,updateConnection, insertversion, getverifiednetworks, getconnections, assignsegmnets, getnetworkId, getgplist, getuserlist, getassignedsegmnets, updtaenetwork, deletenetwork, upload, generateRoute, searchlocation, downloadkml, downloadcsv, savekml, getunverifiednetwork, previewkml, uploadfilterpoints, computeroute, saveproperties, surveyStatus, insertUndergroundSurvey }