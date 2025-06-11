const express = require("express");
const app = express();
app.use(express.json());

const fs = require("fs");
const MISSION_FILE = "missions.json";

/**
 * Parse a hex payload string and extract GPS coordinates.
 * Assumes:
 *  - Payload is a hex string (no spaces).
 *  - Latitude and longitude are each 4-byte signed ints (little-endian),
 *    at offsets 10 and 14 (0-based), representing degrees × 1e7.
 *
 * @param {string} hexPayload - The raw payload as a hex string.
 * @returns {{ latitude: number, longitude: number }} Parsed coordinates in degrees.
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

    // Offsets for latitude and longitude (0-based)
    const LAT_OFFSET = 10;
    const LON_OFFSET = 14;

    // Read 32-bit signed integers
    const rawLat = view.getInt32(LAT_OFFSET, true);
    const rawLon = view.getInt32(LON_OFFSET, true);

    // Convert to degrees
    const latitude = rawLat / 1e7;
    const longitude = rawLon / 1e7;

    return { latitude, longitude };
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
        return res.status(400).send("payload manquant");
    }

    console.log("Payload RockBLOCK reçu :", payload);
    try {
        const { latitude, longitude } = parseCoords(payload);
        latestPosition = {
            lat: latitude,
            lon: longitude,
            yaw: 0,
            airspeed: 0,
            groundspeed: 0,
            alt: 0,
            sysid: 1
        };
        console.log("Rock position reçue :", latestPosition);
        res.sendStatus(200);
    } catch (e) {
        console.error("Erreur parsing RockBLOCK :", e.message, "payload:", payload);
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

app.use(express.static("public"));

app.listen(process.env.PORT || 3000, () => {
    console.log("Serveur HTTP prêt sur le port", process.env.PORT || 3000);
});