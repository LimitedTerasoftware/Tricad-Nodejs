const fs = require("fs");
const path = require("path");
const piexif = require("piexifjs");
const pool = require("../db");

// Convert decimal ? DMS rational
function toDMSRational(dec) {
  const deg = Math.floor(Math.abs(dec));
  const minFloat = (Math.abs(dec) - deg) * 60;
  const min = Math.floor(minFloat);
  const sec = Math.round((minFloat - min) * 60 * 10000);

  return [
    [deg, 1],
    [min, 1],
    [sec, 10000]
  ];
}

// Convert URL ? local path
function urlToLocalPath(url) {
  const fileName = path.basename(url);
  return `/var/www/html/Tricad/uploads/images/${fileName}`;
}

// Extract images from DB row
function extractImageUrls(item) {
  const list = [];
  const addJSON = (str) => { try { const t = JSON.parse(str); if (Array.isArray(t)) list.push(...t); } catch {} };

  try {
    if (item.fpoiUrl && item.surveyUploaded === "true" && item.event_type === "FPOI")
      list.push(item.fpoiUrl);

    if (item.kmtStoneUrl && item.surveyUploaded === "true" && item.event_type === "KILOMETERSTONE")
      list.push(item.kmtStoneUrl);

    if (item.landMarkUrls && item.surveyUploaded === "true" && item.event_type === "LANDMARK")
      addJSON(item.landMarkUrls);

    if (item.fiberTurnUrl && item.surveyUploaded === "true" && item.event_type === "FIBERTURN")
      list.push(item.fiberTurnUrl);

    if (item.start_photos && item.surveyUploaded === "true" && item.event_type === "SURVEYSTART")
      addJSON(item.start_photos);

    if (item.end_photos && item.surveyUploaded === "true" && item.event_type === "ENDSURVEY")
      addJSON(item.end_photos);

    if (item.jointChamberUrl && item.surveyUploaded === "true" && item.event_type === "JOINTCHAMBER")
      list.push(item.jointChamberUrl);

    if (item.road_crossing) {
      try {
        const rc = JSON.parse(item.road_crossing);
        if (rc.startPhoto) list.push(rc.startPhoto);
        if (rc.endPhoto) list.push(rc.endPhoto);
      } catch {}
    }

    if (item.routeIndicatorUrl && item.surveyUploaded === "true" && item.event_type === "ROUTEINDICATOR") {
      try {
        const parsed = JSON.parse(item.routeIndicatorUrl);
        if (Array.isArray(parsed)) list.push(...parsed);
        else list.push(parsed);
      } catch {
        list.push(item.routeIndicatorUrl);
      }
    }

  } catch (err) {
    console.log("Error parsing image URLs:", err);
  }

  return list;
}

// Add EXIF and overwrite image
   
async function addExifToLocalImage(imageUrl, row) {
  const imagePath = urlToLocalPath(imageUrl);

  if (!fs.existsSync(imagePath)) {
    console.log("? Image missing:", imagePath);
    return false;
  }

  // EXTENSION CHECK
  const ext = path.extname(imagePath).toLowerCase();
  if (ext !== ".jpg" && ext !== ".jpeg") {
    console.log("?? Skipping NON-JPEG file:", imagePath);
    return false;
  }

  // FILE SIZE CHECK
  const fileStats = fs.statSync(imagePath);
  if (fileStats.size < 500) {
    console.log("?? Skipping EMPTY / INVALID file:", imagePath);
    return false;
  }

  let buffer = fs.readFileSync(imagePath);
  let jpegBinary;

  // VALID JPEG CHECK (First 2 bytes must be FF D8)
  if (!(buffer[0] === 0xff && buffer[1] === 0xd8)) {
    console.log("?? File is NOT a JPEG header, skipping:", imagePath);
    return false;
  }

  try {
    jpegBinary = buffer.toString("binary");
  } catch (e) {
    console.log("?? Could not convert to binary, skipping:", imagePath);
    return false;
  }

  // GPS DATA
  try {
    const gps = {};
    gps[piexif.GPSIFD.GPSLatitudeRef] = row.latitude >= 0 ? "N" : "S";
    gps[piexif.GPSIFD.GPSLatitude] = toDMSRational(row.latitude);

    gps[piexif.GPSIFD.GPSLongitudeRef] = row.longitude >= 0 ? "E" : "W";
    gps[piexif.GPSIFD.GPSLongitude] = toDMSRational(row.longitude);

    // TIMESTAMP
    let ts = row.createdTime;
    if (!ts) ts = new Date();
    if (ts instanceof Date) {
      const yyyy = ts.getFullYear();
      const mm = String(ts.getMonth() + 1).padStart(2, "0");
      const dd = String(ts.getDate()).padStart(2, "0");
      const hh = String(ts.getHours()).padStart(2, "0");
      const min = String(ts.getMinutes()).padStart(2, "0");
      const ss = String(ts.getSeconds()).padStart(2, "0");
      ts = `${yyyy}:${mm}:${dd} ${hh}:${min}:${ss}`;
    }

    const [date, time] = ts.split(" ");
    const [hh, mm, ss] = time.split(":").map(Number);

    gps[piexif.GPSIFD.GPSDateStamp] = date;
    gps[piexif.GPSIFD.GPSTimeStamp] = [
      [hh, 1],
      [mm, 1],
      [ss, 1],
    ];

    const exifBytes = piexif.dump({ GPS: gps });

    let newData;
    try {
      newData = piexif.insert(exifBytes, jpegBinary);
    } catch (err) {
      console.log("?? piexif insert failed, skipping:", imagePath, err.message);
      return false;
    }

    fs.writeFileSync(imagePath, Buffer.from(newData, "binary"));
    console.log("? EXIF added:", imagePath);
    return true;

  } catch (err) {
    console.log("?? Skipped due to unexpected error:", imagePath, err.message);
    return false;
  }
}


// ====================================================================================
// ??? FIXED MAIN API � CORRECT BLOCK ? SURVEY ? DATA FLOW ???
// ====================================================================================

async function runExifForBlock(req, res) {
  try {
    const { block_id } = req.body;

    if (!block_id)
      return res
        .status(400)
        .json({ status: false, message: "block_id is required" });

    console.log("?? EXIF Worker started for block:", block_id);

    // 2?? Get all survey IDs for this block
    const [surveys] = await pool.query(
      `SELECT id FROM underground_fiber_surveys
   WHERE block_id = ? AND is_active = 1`,
      [block_id]
    );

    if (!surveys.length)
      return res.json({ status: false, message: "No surveys for this block" });

    const surveyIds = surveys.map(s => s.id);


    // 3?? Get survey data for all surveys
    const [rows] = await pool.query(
      `SELECT * FROM underground_survey_data
       WHERE survey_id_int IN (?) 
       AND exif_status = 'pending'
       ORDER BY createdTime ASC`,
      [surveyIds]
    );

    if (!rows.length)
      return res.json({ status: true, message: "No pending EXIF records" });

    let processed = 0;

    for (const item of rows) {
      const urls = extractImageUrls(item);

      for (const url of urls) {
        await addExifToLocalImage(url, item);
      }

      await pool.query(
        "UPDATE underground_survey_data SET exif_status='completed' WHERE id=?",
        [item.id]
      );

      processed++;
    }

    return res.json({
      status: true,
      message: "EXIF added successfully",
      total_records: processed,
    });
  } catch (err) {
    console.log("? Error in EXIF worker:", err);
    return res.status(500).json({
      status: false,
      message: "Internal server error",
      error: err.message,
    });
  }
}
module.exports = { runExifForBlock };
