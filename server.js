const express = require("express");
const app = express();
app.use(express.json());

const fs = require("fs");
const MISSION_FILE = "missions.json";
const util = require("util");
const { spawn } = require("child_process");
const net = require("net");
const path = require("path");
// global fetch is available in Node 18+

// In-memory store of the last 100 RockBLOCK related log lines
const rockLogs = [];

// Store up to the last 200 battery JSON payloads
const batteryMessages = [];

// Store the most recent message posted to /rockremote
let lastRockRemoteMessage = null;
// Store the most recent message posted to /test
let lastTestMessage = null;

function rockLog(...args) {
    const msg = args
        .map(a => (typeof a === "string" ? a : util.inspect(a)))
        .join(" ");
    const line = `${new Date().toISOString()} ${msg}`;
    rockLogs.push(line);
    if (rockLogs.length > 100) {
        rockLogs.splice(0, rockLogs.length - 100);
    }
}

const IMEI_SYSID_MAP = {
    "300434064530460": 6,
    "300434067440370": 12,
    "300434065249660": 2,
    "300434066091890": 8,
    "300434068256680": 10,
    "300434066092880": 11,
    "300434067443400": 14,
    "300434068634200": 15,
    "300434068634370": 16,
    "300434067546540": 18,
    "300434068253680": 19,
    "300434068636350": 20,
    "300434068250680": 22,
    "300434064113950": 27,
    "301434060809570": 28,
    "300434068257650": 0,
    "301434060229740": 0,
    "300434068634420": 0,
    "300434068738420": 0,
    "300434068631370": 0,
    "300434066096910": 0,
    "300434068636340": 0,
    "300434066258480": 1,
    "300434068633350": 4,
    "301434060222750": 5,
    "300434067449360": 6,
    "300434068257590": 7,
    "301434060805560": 8,
    "300434068635340": 0,
    "300434064530640": 0,
    "300434066095900": 0,
    "300434066353150": 0,
    "300434064119860": 0,
    "300434063867370": 0,
    "300434066092920": 0,
    "300434064539500": 0,
    "300434064110870": 0,
    "300434064539560": 0,
    "300434066093870": 0,
    "300434066093860": 0,
    "300434065442370": 0,
    "300434064602350": 0,
    "300434066359080": 0,
    "300434064117950": 0,
    "300434064111940": 0
};

/**
 * Parse a hex payload string and extract GPS coordinates.
 * Assumes:
 *  - Payload is a hex string (no spaces).
 *  - Latitude and longitude are each 4-byte signed ints (little-endian),
 *    at offsets 10 and 14 (0-based), representing degrees × 1e7.
 *
 * @param {string} hexPayload - The raw payload as a hex string.
 * @returns {{ latitude: number, longitude: number, yaw: number, airspeed: number, groundspeed: number }}
 * Parsed coordinates and additional flight data.
 * @throws Will throw an error if payload is too short or invalid.
 */
function parseCoords(hexPayload) {
    if (typeof hexPayload !== 'string' || hexPayload.length < (18 * 2)) {
        throw new Error('Invalid payload: too short or not a hex string');
    }

    // Convert hex string to Uint8Array
    const byteCount = hexPayload.length / 2;
    const bytes = new Uint8Array(byteCount);
    for (let i = 0; i < byteCount; i++) {
        bytes[i] = parseInt(hexPayload.substr(i * 2, 2), 16);
    }

    // DataView for reading little-endian signed ints
    const view = new DataView(bytes.buffer);

    // Offsets for fields within the HIGH_LATENCY2 payload (0-based)
    const LAT_OFFSET = 10;
    const LON_OFFSET = 14;
    const YAW_OFFSET = 32;          // heading
    const AIRSPEED_OFFSET = 35;
    const GROUNDSPEED_OFFSET = 37;
    const WIND_OFFSET = 38;

    // Read 32-bit signed integers
    const rawLat = view.getInt32(LAT_OFFSET, true);
    const rawLon = view.getInt32(LON_OFFSET, true);
    // Heading is stored in the HIGH_LATENCY2 message with a resolution of
    // 2 degrees per unit (0..180 -> 0..360°). Convert it back to degrees.
    const yawRaw = view.getUint8(YAW_OFFSET);
    const yaw = (yawRaw * 2) % 360;
    const airspeed = view.getUint8(AIRSPEED_OFFSET) / 5;
    const groundspeed = view.getUint8(GROUNDSPEED_OFFSET) / 5;
    const windspeed = view.getUint8(WIND_OFFSET) / 5;

    // Convert to degrees
    const latitude = rawLat / 1e7;
    const longitude = rawLon / 1e7;

    return { latitude, longitude, yaw, airspeed, groundspeed, windspeed };
}

// Chargement des missions individuelles (par sysid)
let missionsBySysid = {};
if (fs.existsSync(MISSION_FILE)) {
    missionsBySysid = JSON.parse(fs.readFileSync(MISSION_FILE, "utf-8"));
}

// Chargement des missions multiples (tableau)
let missions = [];

// Gestion du processus GStreamer courant
let streamProcess = null;
const STREAM_MJPEG_PORT = 9001;
const DRONE_STREAM_PORT = 5000; // udpsink host=<server_ip> port=5000

const streamLogs = [];

// Latest JPEG frame captured from the GStreamer pipeline
let latestFrame = null;
let frameClient = null;
let frameBuffer = Buffer.alloc(0);
const FRAME_BOUNDARY = Buffer.from('--frame');

function parseFrames() {
    let idx;
    while ((idx = frameBuffer.indexOf(FRAME_BOUNDARY)) !== -1) {
        if (idx > 0) {
            frameBuffer = frameBuffer.slice(idx);
        }
        const headerEnd = frameBuffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) break;
        const next = frameBuffer.indexOf(FRAME_BOUNDARY, headerEnd + 4);
        if (next === -1) break;
        latestFrame = Buffer.from(frameBuffer.slice(headerEnd + 4, next));
        frameBuffer = frameBuffer.slice(next);
    }
}

function logStream(data) {
    const line = data.toString();
    streamLogs.push(line);
    if (streamLogs.length > 50) {
        streamLogs.splice(0, streamLogs.length - 50);
    }
    console.log("[GST]", line.trim());
}


// Variable pour conserver la dernière position
let latestPosition = null;

app.post("/drone-position", (req, res) => {
    latestPosition = { windspeed: 0, ...req.body };
    console.log("Position reçue :", latestPosition);
    res.sendStatus(200);
});

app.get("/drone-position", (req, res) => {
    if (latestPosition) {
        res.json(latestPosition);
    } else {
        res.status(204).send();
    }
});

// Endpoint pour recevoir un payload RockBLOCK et mettre à jour la position
app.post("/rock", (req, res) => {
    // Nouveau format : le champ "data" contient la payload hexadécimale. On
    // conserve la compatibilité avec l'ancien champ "payload" si présent.
    const payload =
        typeof req.body.data === "string"
            ? req.body.data
            : typeof req.body.payload === "string"
                ? req.body.payload
                : undefined;

    if (!payload) {
        console.log("Payload RockBLOCK invalide :", req.body);
        rockLog("Payload RockBLOCK invalide :", req.body);
        return res.status(400).send("payload manquant");
    }

    console.log("Payload RockBLOCK reçu :", payload);
    rockLog("Payload RockBLOCK reçu :", payload);
    try {
        const { latitude, longitude, yaw, airspeed, groundspeed, windspeed } = parseCoords(payload);
        const sysid = IMEI_SYSID_MAP[req.body.imei] ?? 0;
        latestPosition = {
            lat: latitude,
            lon: longitude,
            yaw,
            airspeed,
            groundspeed,
            alt: 0,
            windspeed,
            sysid: sysid
        };
        console.log("Rock position reçue :", latestPosition);
        rockLog("Rock position reçue :", latestPosition);
        res.sendStatus(200);
    } catch (e) {
        console.error("Erreur parsing RockBLOCK :", e.message, "payload:", payload);
        rockLog("Erreur parsing RockBLOCK :", e.message, "payload:", payload);
        res.status(400).send(e.message);
    }
});

// Endpoint pour recevoir une mission individuelle (type waypoints)
// Endpoint pour recevoir une mission individuelle (type waypoints)
app.post("/drone-mission", (req, res) => {
    const { sysid } = req.body;
    if (!sysid) {
        return res.status(400).send("sysid manquant");
    }
    missionsBySysid[sysid] = {
        ...req.body,
        receivedAt: Date.now()
    };
    // Ajout : stocker aussi dans le tableau missions
    missions = missions.filter(m => m.sysid !== req.body.sysid);
    missions.push({
        waypoints: req.body.waypoints,
        sysid: req.body.sysid,
        timestamp: Date.now()
    });
    fs.writeFileSync(MISSION_FILE, JSON.stringify(missionsBySysid));
    console.log("Mission reçue pour sysid", sysid, ":", req.body);
    res.sendStatus(200);
});



// Endpoint pour obtenir les missions des 4 dernières heures
app.get("/drone-missions/recent", (req, res) => {
    const now = Date.now();
    const fourHours = 4 * 60 * 60 * 1000;
    res.json(missions.filter(m => now - m.timestamp <= fourHours));
});

// (Optionnel) Endpoint pour obtenir toutes les missions
app.get("/drone-missions", (req, res) => {
    res.json(missions);
});

// Endpoint to view last 100 RockBLOCK logs
app.get("/rocklog", (req, res) => {
    res.type("text/plain").send(rockLogs.slice(-100).join("\n"));
});

// Store a battery status JSON payload
app.post("/battery", (req, res) => {
    batteryMessages.push(req.body);
    if (batteryMessages.length > 200) {
        batteryMessages.splice(0, batteryMessages.length - 200);
    }
    res.sendStatus(200);
});

// Retrieve the last 200 battery status messages
app.get("/battery", (req, res) => {
    res.json(batteryMessages.slice(-200));
});

// Proxy elevation requests to OpenTopodata to avoid CORS issues
app.get("/elevation", async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    const { lat, lon } = req.query;
    if (!lat || !lon) return res.status(400).send("missing lat or lon");
    try {
        const url = `https://api.opentopodata.org/v1/test-dataset?locations=${lat},${lon}`;
        const r = await fetch(url);
        if (!r.ok) throw new Error(`remote ${r.status}`);
        const j = await r.json();
        res.json({ elevation: j.results?.[0]?.elevation ?? 0 });
    } catch (e) {
        console.error("elevation proxy", e);
        res.json({ elevation: 0 });
    }
});

// Store and display the most recent JSON message posted to /rockremote
app.post("/rockremote", (req, res) => {
    lastRockRemoteMessage = req.body;
    res.sendStatus(200);
});

app.get("/rockremote", (req, res) => {
    if (lastRockRemoteMessage) {
        res.json(lastRockRemoteMessage);
    } else {
        res.status(204).send();
    }
});

// Store and retrieve JSON messages via /test
app.post("/test", (req, res) => {
    lastTestMessage = req.body;
    res.sendStatus(200);
});

app.get("/test", (req, res) => {
    if (lastTestMessage) {
        res.json(lastTestMessage);
    } else {
        res.status(204).send();
    }
});


// Dernières lignes de logs du pipeline vidéo
app.get("/stream/log", (req, res) => {
    res.type("text/plain").send(streamLogs.slice(-50).join(""));
});

// Page webstreamer
app.get("/webstreamer", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "webstreamer.html"));
});

// Page webviewer (snapshot view)
app.get("/webviewer", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "webviewer.html"));
});

// Lancer un pipeline GStreamer
app.post("/stream/start", (req, res) => {
    const { pipeline } = req.body;
    if (!pipeline) return res.status(400).send("pipeline manquant");
    if (streamProcess) return res.status(400).send("pipeline déjà lancé");
    const cmd = `gst-launch-1.0 ${pipeline} ! jpegenc ! multipartmux boundary=frame ! tcpserversink host=127.0.0.1 port=${STREAM_MJPEG_PORT}`;

    streamLogs.length = 0;
    console.log("Starting GStreamer:", cmd);
    streamProcess = spawn("sh", ["-c", cmd]);
    streamProcess.stdout.on("data", logStream);
    streamProcess.stderr.on("data", logStream);
    frameBuffer = Buffer.alloc(0);
    latestFrame = null;
    // Explicitly use IPv4 loopback to avoid resolving to ::1 on some systems
    frameClient = net.connect(STREAM_MJPEG_PORT, "127.0.0.1");
    frameClient.on("data", chunk => {
        frameBuffer = Buffer.concat([frameBuffer, chunk]);
        parseFrames();
    });
    frameClient.on("end", () => { frameClient = null; });
    streamProcess.on("exit", code => {
        logStream(`Process exited with code ${code}`);
        streamProcess = null;
        if (frameClient) {
            frameClient.destroy();
            frameClient = null;
        }
    });
    return res.sendStatus(200);
});

// Arrêter le pipeline
app.post("/stream/stop", (req, res) => {
    if (streamProcess) {
        streamProcess.kill("SIGTERM");
        streamProcess = null;
        logStream("Process stopped");
        if (frameClient) {
            frameClient.destroy();
            frameClient = null;
        }
    }
    res.sendStatus(200);
});

// Dernière image JPEG capturée
app.get("/video", (req, res) => {
    if (!latestFrame) return res.status(404).send("no frame");
    res.writeHead(200, {
        "Content-Type": "image/jpeg",
        "Cache-Control": "no-cache, no-store, must-revalidate"
    });
    res.end(latestFrame);
});

// Flux MJPEG produit par GStreamer
app.get("/stream/video", (req, res) => {
    if (!streamProcess) return res.status(404).send("no stream");
    res.writeHead(200, {
        "Content-Type": "multipart/x-mixed-replace; boundary=frame"
    });
    // Ensure we connect over IPv4 to match tcpserversink binding
    const client = net.connect(STREAM_MJPEG_PORT, "127.0.0.1");
    client.on("data", chunk => res.write(chunk));
    client.on("end", () => res.end());
    req.on("close", () => client.destroy());
});

app.use(express.static("public"));

app.listen(process.env.PORT || 3000, () => {
    console.log("Serveur HTTP prêt sur le port", process.env.PORT || 3000);
});
