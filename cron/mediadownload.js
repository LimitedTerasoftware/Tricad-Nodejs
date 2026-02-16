const fs = require("fs");
const path = require("path");
const archiver = require("archiver");
const pool = require("../db");

// Convert URL to local path
const urlToLocalImagePath = (url) =>
  url ? `/var/www/html/Tricad/uploads/images/${path.basename(url)}` : null;

function buildEventImageName(item, localPath) {
  const safeEvent = (item.event_type || "EVENT").replace(/[^a-zA-Z0-9]/g, "_");
  return `${safeEvent}_${path.basename(localPath)}`;
}

// Convert video filename to local path
const localVideoPath = (videoUrl) => {
  if (!videoUrl) return null;
  const fullPath = path.join("/var/www/html/Tricad", videoUrl);
  if (!fs.existsSync(fullPath)) console.log("? Video missing:", fullPath);
  return fs.existsSync(fullPath) ? fullPath : null;
};

// Extract images
const extractImageUrls = (item) => {
  const result = [];
  const parseJSON = (str) => {
    try {
      const arr = JSON.parse(str);
      if (Array.isArray(arr)) result.push(...arr);
    } catch {}
  };

  if (item.event_type === "FPOI" && item.fpoiUrl) result.push(item.fpoiUrl);
  if (item.event_type === "KILOMETERSTONE" && item.kmtStoneUrl)
    result.push(item.kmtStoneUrl);
  if (item.event_type === "FIBERTURN" && item.fiberTurnUrl)
    result.push(item.fiberTurnUrl);
  if (item.event_type === "LANDMARK" && item.landMarkUrls)
    parseJSON(item.landMarkUrls);
  if (item.event_type === "SURVEYSTART" && item.start_photos)
    parseJSON(item.start_photos);
  if (item.event_type === "ENDSURVEY" && item.end_photos)
    parseJSON(item.end_photos);
  if (item.event_type === "ROUTEINDICATOR" && item.routeIndicatorUrl) {
    try {
      const parsed = JSON.parse(item.routeIndicatorUrl);
      Array.isArray(parsed) ? result.push(...parsed) : result.push(parsed);
    } catch {
      result.push(item.routeIndicatorUrl);
    }
  }

  return result;
};

// Extract videos
const extractVideoUrls = (item) => {
  try {
    if (item.event_type === "VIDEORECORD" && item.surveyUploaded === "true") {
      const details = JSON.parse(item.videoDetails || "{}");
      return details.videoUrl ? [details.videoUrl] : [];
    }
  } catch (err) {
    console.log("Video parse error:", err);
  }
  return [];
};

// MAIN
async function downloadBlockMedia(req, res) {
  try {
    console.log("hellooo");
    const block_id = req.params.block_id;
    const type = (req.query.type || "both").toLowerCase();
    if (!block_id)
      return res
        .status(400)
        .json({ status: false, message: "block_id required" });
    if (!["image", "video", "both"].includes(type))
      return res
        .status(400)
        .json({ status: false, message: "type must be image/video/both" });

    // 1. Surveys
    const [surveys] = await pool.query(
      `
      SELECT id, startLocation, endLocation 
      FROM underground_fiber_surveys 
      WHERE block_id=? AND is_active=1 AND (routeType IN ('PROPOSED','INCREMENTAL') OR routeType IS NULL)
    `,
      [block_id]
    );
    if (!surveys.length)
      return res.json({ status: false, message: "No surveys" });

    const [blockRows] = await pool.query(
      "SELECT block_name FROM blocks WHERE block_id=? LIMIT 1",
      [block_id]
    );
    const blockName = blockRows?.[0]?.block_name || `Block_${block_id}`;

    // 2. GPS map
    const locIds = [
      ...new Set(
        surveys.flatMap((s) => [s.startLocation, s.endLocation].filter(Boolean))
      ),
    ];
    const [gpsRows] = locIds.length
      ? await pool.query("SELECT id,name FROM gpslist WHERE id IN (?)", [
          locIds,
        ])
      : [[]];
    const gpsMap = Object.fromEntries(
      gpsRows.map((g) => [g.id, g.name || `ID${g.id}`])
    );

    // 3. Route mapping
    const routeMap = {};
    surveys.forEach((s) => {
      const route = `${gpsMap[s.startLocation] || `S${s.startLocation}`}_${
        gpsMap[s.endLocation] || `E${s.endLocation}`
      }`;
      if (!routeMap[route]) routeMap[route] = [];
      routeMap[route].push(s.id);
    });

    const allSurveyIds = Object.values(routeMap).flat();

    // 4. Fetch media
    const [rows] = await pool.query(
      "SELECT * FROM underground_survey_data WHERE survey_id_int IN (?) ORDER BY createdTime ASC",
      [allSurveyIds]
    );
    if (!rows.length) return res.json({ status: false, message: "No media" });

    // 5. ZIP
    const zipName = `${blockName}.zip`;
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${zipName}"`);
    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.pipe(res);

    const usedRoutes = { images: new Set(), videos: new Set() };

    rows.forEach((item) => {
      const surveyId = item.survey_id_int;
      const routeFolder = Object.keys(routeMap).find((r) =>
        routeMap[r].includes(surveyId)
      );
      if (!routeFolder) return;

      if (type === "image" || type === "both") {
        extractImageUrls(item).forEach((url) => {
          const local = urlToLocalImagePath(url);
          if (fs.existsSync(local)) {
            const zipImageName = buildEventImageName(item, local);
            archive.file(local, {
              name: `images/${routeFolder}/${zipImageName}`,
            });
            usedRoutes.images.add(routeFolder);
          }
        });
      }

      if (type === "video" || type === "both") {
        extractVideoUrls(item).forEach((vid) => {
          const local = localVideoPath(vid);
          if (local) {
            archive.file(local, {
              name: `videos/${routeFolder}/${path.basename(local)}`,
            });
            usedRoutes.videos.add(routeFolder);
          }
        });
      }
    });

    if (
      (type === "image" && usedRoutes.images.size === 0) ||
      (type === "video" && usedRoutes.videos.size === 0) ||
      (type === "both" &&
        usedRoutes.images.size === 0 &&
        usedRoutes.videos.size === 0)
    ) {
      archive.append("No media found for the requested type.", {
        name: "README.txt",
      });
    }

    await archive.finalize();
  } catch (err) {
    console.error("Error:", err);
    if (!res.headersSent)
      res.status(500).json({ status: false, message: "Server Error" });
  }
}

module.exports = { downloadBlockMedia };
