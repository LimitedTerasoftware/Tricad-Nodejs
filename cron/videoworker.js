const pool = require("../db");
const ffmpeg = require("fluent-ffmpeg");
const moment = require("moment");
const path = require("path");
const fs = require("fs");
const cron = require("node-cron");

ffmpeg.setFfmpegPath("/usr/bin/ffmpeg");
ffmpeg.setFfprobePath("/usr/bin/ffprobe");

const BASE_VIDEO_URL = "https://docs.tricadtrack.com/Tricad/";
const OUTPUT_DIR = "/var/www/html/Tricad/uploads/videos1/";
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

async function processNextJob() {
  let connection = null;
  let jobId = null;
  let tempSrtPath = null;

  // These will hold the data we need during the long FFmpeg part
  let job = null;
  let currentRow = null;
  let gpsPoints = [];
  let videoStartMs = null;
  let details = {};
  let videoFilename = "";
  let outputFile = "";

  try {
    // PHASE 1: Get connection + grab ALL data we need
    connection = await pool.getConnection();

   //const [jobs] = await connection.query(
     // `SELECT * FROM video_processing_queue WHERE status='pending' ORDER BY id ASC LIMIT 1`
     //);

      const [jobs] = await connection.query(
  `(
      SELECT * FROM video_processing_queue 
      WHERE status='pending' AND block_id = 544
      ORDER BY id ASC LIMIT 1
   )
   UNION ALL
   (
      SELECT * FROM video_processing_queue 
      WHERE status='pending' AND block_id <> 544
      ORDER BY id ASC LIMIT 1
   )
   LIMIT 1;`
);

    if (!jobs.length) {
      connection.release();
      return;
    }

    job = jobs[0];
    jobId = job.id;
    const originalVideoUrl = job.original_url;
    if (!originalVideoUrl) throw new Error("No original video in queue");

    videoFilename = path.basename(originalVideoUrl);
    outputFile = path.join(OUTPUT_DIR, videoFilename);

    // Mark as processing
    await connection.query(
      `UPDATE video_processing_queue SET status='processing' WHERE id=?`,
      [jobId]
    );

    // Get survey row
    const [rows] = await connection.query(
      `SELECT * FROM underground_survey_data WHERE id=?`,
      [job.survey_data_id]
    );
    if (!rows.length) throw new Error("Survey data not found");
    currentRow = rows[0];

    if (currentRow.event_type !== "VIDEORECORD") {
      await connection.query(
        `UPDATE video_processing_queue SET status='failed', error_message=? WHERE id=?`,
        ["Not VIDEORECORD", jobId]
      );
      connection.release();
      return;
    }

    details = JSON.parse(currentRow.videoDetails || "{}");
    const surveyId = currentRow.survey_id_int;

    // Get all rows for GPS calculation
    const [allRows] = await connection.query(
      `SELECT * FROM underground_survey_data WHERE survey_id_int=? ORDER BY createdTime ASC`,
      [surveyId]
    );

    const currentIndex = allRows.findIndex((r) => r.id === currentRow.id);
    let startIndex = 0;
    for (let i = currentIndex - 1; i >= 0; i--) {
      if (allRows[i].event_type === "VIDEORECORD" || allRows[i].event_type === "SURVEYSTART") {
        startIndex = i + 1;
        break;
      }
    }

    gpsPoints = allRows
      .slice(startIndex, currentIndex)
      .filter((r) => r.event_type === "LIVELOCATION")
      .map((r) => ({
        time: new Date(r.createdTime).getTime(),
        lat: parseFloat(r.latitude).toFixed(6),
        lon: parseFloat(r.longitude).toFixed(6),
        timeStr: moment(r.createdTime).format("hh:mm:ss A"),
      }))
      .sort((a, b) => a.time - b.time);

    videoStartMs =
      gpsPoints.length > 0
        ? gpsPoints[0].time
        : new Date(currentRow.createdTime).getTime();

    console.log(`Processing: ${videoFilename} | GPS Points: ${gpsPoints.length}`);

    // RELEASE THE CONNECTION HERE � THIS IS THE MAGIC FIX
    connection.release();
    connection = null;
    // From now on we do NO DB queries until the very end

    // PHASE 2: Long FFmpeg work (no DB connection held)
    const command = ffmpeg(BASE_VIDEO_URL + originalVideoUrl.replace(/^\/+/, ""))
      .videoCodec("libx264")
      .outputOptions([
        "-preset veryfast",
        "-crf 23",
        "-map 0:v",
        "-map 0:a?",
        "-c:a copy",
      ]);

    const filters = [];
    filters.push({
      filter: "drawbox",
      options: { x: 0, y: 0, w: "iw", h: 70, color: "black@0.7", t: "fill" },
      inputs: "[0:v]",
      outputs: "[bg]",
    });

    if (gpsPoints.length === 0) {
      filters.push({ filter: "null", inputs: "[bg]", outputs: "[vout]" });
    } else if (gpsPoints.length > 300) {
      // SRT method...
      let srt = "";
      let idx = 1;
      const toTime = (sec) => {
        const d = new Date(sec * 1000);
        return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}:${String(d.getUTCSeconds()).padStart(2, "0")},${String(d.getUTCMilliseconds()).padStart(3, "0")}`;
      };
      for (let i = 0; i < gpsPoints.length; i++) {
        const startSec = (gpsPoints[i].time - videoStartMs) / 1000;
        if (startSec < 0) continue;
        const endSec = i < gpsPoints.length - 1
          ? (gpsPoints[i + 1].time - videoStartMs) / 1000
          : startSec + 60;

        const leftText = `${gpsPoints[i].lat}, ${gpsPoints[i].lon}`;
        const rightText = gpsPoints[i].timeStr;
        const paddedTime = rightText.padStart(11, " ");
        const spaces = " ".repeat(48 - leftText.length);
        srt += `${idx}\n${toTime(startSec)} --> ${toTime(endSec)}\n${leftText}${spaces}${paddedTime}\n\n`;
        idx++;
      }
      tempSrtPath = `/tmp/gps_${jobId}.srt`;
      fs.writeFileSync(tempSrtPath, srt);

      filters.push({
        filter: "subtitles",
        options: {
          filename: tempSrtPath.replace(/:/g, "\\:"),
          force_style: "FontName=DejaVu Sans,FontSize=15,PrimaryColour=&HFFFFFF&,Bold=1,Alignment=7,MarginL=20,MarginR=20,MarginV=25",
        },
        inputs: "[bg]",
        outputs: "[vout]",
      });
    } else {
      // drawtext method (same as before)
      let last = "[bg]";
      gpsPoints.forEach((p, i) => {
        const start = ((p.time - videoStartMs) / 1000).toFixed(3);
        const end = i < gpsPoints.length - 1
          ? ((gpsPoints[i + 1].time - videoStartMs) / 1000).toFixed(3)
          : "999999";
        const next = i === gpsPoints.length - 1 ? "[vout]" : `[t${i}]`;

        filters.push({ filter: "drawtext", options: { fontfile: "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", text: `${p.lat}, ${p.lon}`, fontcolor: "white", fontsize: 15, x: 20, y: 45, enable: `between(t,${start},${end})` }, inputs: last, outputs: `[lat${i}]` });

        filters.push({ filter: "drawtext", options: { fontfile: "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", text: p.timeStr.replace(/:/g, "\\\\:"), fontcolor: "white", fontsize: 15, x: "w-tw-20", y: 45, enable: `between(t,${start},${end})` }, inputs: `[lat${i}]`, outputs: next });

        last = next;
      });
    }

    command.complexFilter(filters, "vout");

    await new Promise((resolve, reject) => {
      command
        .on("start", () => console.log(`Started: ${videoFilename}`))
        .on("end", () => { console.log(`SUCCESS: ${videoFilename}`); resolve(); })
        .on("error", (err) => { console.error("FFmpeg Error:", err.message); reject(err); })
        .save(outputFile);
    });

    // Faststart
    const fixed = outputFile.replace(".mp4", "_fixed.mp4");
    await new Promise((r, rej) => {
      ffmpeg(outputFile)
        .outputOptions(["-movflags", "+faststart", "-c", "copy"])
        .on("end", () => { fs.renameSync(fixed, outputFile); r(); })
        .on("error", rej)
        .save(fixed);
    });

    // PHASE 3: Get a FRESH connection only to write final results
    connection = await pool.getConnection();

    const finalUrl = `/uploads/videos1/${videoFilename}`;
    const newDetails = { ...details, videoUrl: finalUrl };

    await connection.query(
      `UPDATE underground_survey_data SET videoDetails=? WHERE id=?`,
      [JSON.stringify(newDetails), currentRow.id]
    );

    await connection.query(
      `UPDATE video_processing_queue SET status='completed', processed_url=? WHERE id=?`,
      [finalUrl, jobId]
    );

    console.log(`JOB ${jobId} 100% DONE � NO MORE LOCK TIMEOUTS`);

  } catch (err) {
    console.error("ERROR in job", jobId, ":", err.message);

    // Try to mark as failed with a new connection (in case old one is dead)
    try {
      if (!connection) connection = await pool.getConnection();
      await connection.query(
        `UPDATE video_processing_queue SET status='failed', error_message=? WHERE id=?`,
        [err.message.substring(0, 500) || "Unknown error", jobId]
      );
    } catch (e) {
      console.error("Could not even mark as failed:", e.message);
    }
  } finally {
    if (connection) connection.release();
    if (tempSrtPath && fs.existsSync(tempSrtPath)) fs.unlinkSync(tempSrtPath);
  }
}
let running = false;
cron.schedule("*/30 * * * * *", () => {
  if (running) return;
  running = true;
  processNextJob().finally(() => (running = false));
});

module.exports = { processNextJob };
