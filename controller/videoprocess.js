const pool = require("../db");
const ffmpeg = require("fluent-ffmpeg");
const moment = require("moment");
const path = require("path");
const fs = require("fs");

async function processvideo(req, res) {
  const { state_code, district_code, block_code } = req.body;

  if (!state_code || !district_code || !block_code) {
    return res.status(400).json({ error: "Missing state/district/block" });
  }

  let connection;
  const queuedVideos = [];

  try {
    connection = await pool.getConnection();

    // 1?? Get all active surveys for the block
    const [surveys] = await connection.query(
      `SELECT id 
   FROM underground_fiber_surveys
   WHERE state_id = ?
     AND district_id = ?
     AND block_id = ?
     AND is_active = 1
        AND (routeType IN ('PROPOSED', 'INCREMENTAL', 'NOT FEASIBLE ROUTE') OR routeType IS NULL)
  `,
      [state_code, district_code, block_code]
    );

    if (!surveys || surveys.length === 0) {
      return res.json({ message: "No active surveys found" });
    }

    const surveyIds = surveys.map((s) => s.id);

    // 2?? Fetch all survey data
    const [surveyData] = await connection.query(
      `SELECT * FROM underground_survey_data
       WHERE survey_id_int IN (?) ORDER BY createdTime ASC`,
      [surveyIds]
    );

    if (!surveyData || surveyData.length === 0) {
      return res.json({ message: "No survey data found" });
    }

    // 3?? Identify video rows
    const videos = surveyData
      .filter(
        (row) =>
          row.event_type === "VIDEORECORD" && row.surveyUploaded === "true"
      )
      .map((row) => ({
        survey_data_id: row.id,
        survey_id: row.survey_id_int,
        block_id: block_code,
        original_url: JSON.parse(row.videoDetails).videoUrl,
      }));

    if (videos.length === 0) {
      return res.json({ message: "No videos found for this block" });
    }

    // 4?? Insert videos into queue
    for (const video of videos) {
      const [result] = await connection.query(
        `INSERT INTO video_processing_queue
         (survey_data_id, survey_id, block_id, original_url, status)
         VALUES (?, ?, ?, ?, 'pending')`,
        [
          video.survey_data_id,
          video.survey_id,
          video.block_id,
          video.original_url,
        ]
      );

      queuedVideos.push({
        queue_id: result.insertId,
        survey_data_id: video.survey_data_id,
        original_url: video.original_url,
      });
    }

    return res.json({
      success: true,
      message: `${queuedVideos.length} videos added to the processing queue`,
      queued_videos: queuedVideos,
    });
  } catch (err) {
    console.error("Error in processvideo API:", err);
    return res
      .status(500)
      .json({ error: err.message || "Internal server error" });
  } finally {
    if (connection) connection.release();
  }
}

module.exports = { processvideo };
