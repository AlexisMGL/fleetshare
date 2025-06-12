const express = require("express");
const app = express();
app.use(express.json());

const fs = require("fs");
const MISSION_FILE = "missions.json";
const util = require("util");

// In-memory store of the last 100 RockBLOCK related log lines
const rockLogs = [];

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

    // Read 32-bit signed integers
    const rawLat = view.getInt32(LAT_OFFSET, true);
    const rawLon = view.getInt32(LON_OFFSET, true);
    // Heading is stored in the HIGH_LATENCY2 message with a resolution of
    // 2 degrees per unit (0..180 -> 0..360°). Convert it back to degrees.
    const yawRaw = view.getUint8(YAW_OFFSET);
    const yaw = (yawRaw * 2) % 360;
    const airspeed = view.getUint8(AIRSPEED_OFFSET) / 5;
    const groundspeed = view.getUint8(GROUNDSPEED_OFFSET) / 5;

    // Convert to degrees
    const latitude = rawLat / 1e7;
    const longitude = rawLon / 1e7;

    return { latitude, longitude, yaw, airspeed, groundspeed };
}

// Chargement des missions individuelles (par sysid)
let missionsBySysid = {};
if (fs.existsSync(MISSION_FILE)) {
    missionsBySysid = JSON.parse(fs.readFileSync(MISSION_FILE, "utf-8"));
}

// Chargement des missions multiples (tableau)
let missions = [];

// Variable pour conserver la dernière position
let latestPosition = null;

app.post("/drone-position", (req, res) => {
    latestPosition = req.body;
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
        const { latitude, longitude, yaw, airspeed, groundspeed } = parseCoords(payload);
        const sysid = IMEI_SYSID_MAP[req.body.imei] ?? 0;
        latestPosition = {
            lat: latitude,
            lon: longitude,
            yaw,
            airspeed,
            groundspeed,
            alt: 0,
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

app.use(express.static("public"));

app.listen(process.env.PORT || 3000, () => {
    console.log("Serveur HTTP prêt sur le port", process.env.PORT || 3000);
});
