const express = require("express");
const app = express();
app.use(express.json());

const fs = require("fs");
const MISSION_FILE = "missions.json";

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