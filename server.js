const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const mysql = require('mysql2/promise');
const construction = require("./controller/construction-form")
const smartinventory = require("./controller/smartinventory")
const routebuilder = require("./controller/routebuilder")



const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }))
const port = 8000;

const upload = multer({ dest: 'uploads/' });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

//--------------------------------routeBuilder-------------------------------------------------

app.post('/upload-points', upload.single('pointsFile'), routebuilder.uploadPoints)




app.post('/upload-connections', upload.single('connectionsFile'), routebuilder.uploadConnection)

app.get('/show-route', routebuilder.showRoute)



//----------------------all APIS RELATED TO DB-------------------------------------------------------------

app.post('/save-to-db', routebuilder.savetodb)

app.post("/verify-network", routebuilder.verifynetwok)

app.get('/get-verified-netwrorks', routebuilder.getverifiednetworks)

app.get('/get-connection', routebuilder.getconnections);

app.post("/assign-segment", routebuilder.assignsegmnets)

app.get('/get-networks/:id', routebuilder.getnetworkId)

app.get('/get-gplist/:id', routebuilder.getgplist);

app.get("/user-list", routebuilder.getuserlist)

app.get("/get-assigned-networks/:id", routebuilder.getassignedsegmnets);

app.put('/update-network/:networkId', routebuilder.updtaenetwork);

app.post('/delete-network/:networkId', routebuilder.deletenetwork);

app.post('/upload', upload.fields([{ name: 'pointsFile', maxCount: 1 }, { name: 'connectionsFile', maxCount: 1 }]), routebuilder.upload)

app.post('/generate-route', upload.fields([{ name: 'pointsFile', maxCount: 1 }]), routebuilder.generateRoute);

app.get('/search-location', routebuilder.searchlocation);

app.post('/download/kml', routebuilder.downloadkml);

app.post('/download/csv', routebuilder.downloadcsv);

app.post('/save-kml', routebuilder.savekml);

app.get('/get-unverified-networks', routebuilder.getunverifiednetwork);

// Preview KML file
app.get('/preview-file', async (req, res) => {
    let connection;
    try {
        const { filepath, fileType } = req.query;

        if (!filepath) {
            return res.status(400).json({ error: 'filepath query parameter is required' });
        }

        connection = await pool.getConnection();

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
            const parsedResult = smartinventory.parseKmz(buffer);

            // Map to your desired format
            parsedData.points = parsedResult.points.map(p => ({
                name: p.name,
                coordinates: {
                    longitude: p.coordinates[0],
                    latitude: p.coordinates[1]
                },
                 type: p.type ? p.type : "point",
                properties : p.properties
            }));

            //---------polylines---------------------------------------

            parsedData.polylines = parsedResult.lines.map(line => ({
                name: line.name,
                type: line.type, // <-- Include type: "Proposed Cable" or "Incremental Cable"
                styleUrl: null,
                distance: line.length ? parseFloat(line.length) : null,
                coordinates: line.coordinates,
                properties : line.properties
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
        if (connection) {
            connection.release();
        }
    }
});

const compression = require('compression');

const compressResponse = compression({
    level: 6, // Balanced compression (0-9)
    threshold: 1000, // Compress responses >1KB
    filter: (req, res) => {
        return res.getHeader('Content-Type')?.includes('application/json') || false;
    },
});

app.post('/upload-filtered-points', upload.single('filteredPointsFile'), compressResponse, routebuilder.uploadfilterpoints);

app.post('/compute-route', routebuilder.computeroute);


//--------------------------------------------smart inventory apis ---------------------------------------------------------------------
const generateFilename = (ext) => {
    const timestamp = new Date().toISOString().replace(/[-T:]/g, '').split('.')[0]; // e.g., 20250624142830
    return `${timestamp}${ext}`;
};

``
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        const folder = ext === '.kml' ? 'externaldata/KML/' : 'externaldata/KMZ/';
        if (!fs.existsSync(folder)) {
            fs.mkdirSync(folder, { recursive: true });
        }
        cb(null, folder);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, generateFilename(ext));
    }
});

// File filter and validation
const uploads = multer({
    storage,
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (ext !== '.kml' && ext !== '.kmz') {
            return cb(new Error('Only KML and KMZ files are allowed'), false);
        }
        cb(null, true);
    },
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
}).fields([
    { name: 'desktop_planning', maxCount: 1 },
    { name: 'physical_survey', maxCount: 1 }
]);


app.post('/upload-external-data', uploads, smartinventory.uploadExternalData)

app.get('/get-external-files', smartinventory.getEXternalfiles);

app.get('/preview-file', smartinventory.previewfile);

//----------------------------CONSTRUCTION-FORM -APIS-------------------------------------------------------------
app.get("/get-depth-data", construction.getDepthdata)

app.get("/get-filtered-data", construction.getDepthDataByDateAndMachine)

app.post("/create-machine", construction.createMachine)

app.put("/update-machine/:machine_id", construction.updateMachine)
app.post("/delete-machine/:machine_id", construction.deleteMachine)

app.get("/get-all-machines", construction.getMachines)

app.post("/create-users", construction.createUser)

app.post("/login", construction.loginUser)

app.post('/survey/create', construction.createsurvey);

app.post("/create-event", construction.createEvent)
app.post('/start-point', construction.startpointevent);
app.get("/get-survey-data", construction.getFilteredSurveys)

app.get("/machine/latest-activity", construction.getLatestMachineActivity)
app.get("/get-daily-distances", construction.getMachineDailyDistances)

app.post("/update-photos", construction.editImages)

app.get("/survey-history", construction.getSurveyHistoryByUser)

app.get("/machine-monthly-amount", construction.getMachineMonthlyAmount)

//-----------------------------------------------------smart Inventory-----------------------------------------------------------------

app.get("/get-physical-survey", smartinventory.getSurveysByLocation)
app.post("/update-physical-survey", construction.editphysicalsurvey)

app.get("/get-firm-names", construction.getAllFirmNames)
app.get("/get-machines", construction.getMachinesByFirm)

app.post("/insert-fpoi", smartinventory.insertFpoi)
app.get("/gpslist", smartinventory.getGpsListPaginated)

app.get("/filterGpsList", smartinventory.filterGpsList)
app.post("/update-gpslist/:id", smartinventory.updateGpsEntry)

const uploadss = multer({ dest: 'uploads/' });

app.post('/upload-kmz', uploadss.single('file'), async (req, res) => {
    try {
        const filePath = req.file.path;
       
        const buffer = fs.readFileSync(filePath);

        const result = smartinventory.parseKmz(buffer);

        // Cleanup
        fs.unlinkSync(filePath);

        res.json({
            success: true,
            message: 'KMZ parsed successfully',
            data: result,
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post("/download-shape", smartinventory.downloadshape)

app.post("/download-excel", smartinventory.downloadExcel)

app.post("/save-properties", routebuilder.saveproperties)


app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});




