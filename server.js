const express = require("express");
const app = express();
app.use(express.json());

// Ajoute en haut du fichier
const fs = require("fs");
const MISSION_FILE = "missions.json";

// Chargement des missions au démarrage
let missions = {};
if (fs.existsSync(MISSION_FILE)) {
    missions = JSON.parse(fs.readFileSync(MISSION_FILE, "utf-8"));
}

// Variable pour conserver la dernière position
let latestPosition = null;

app.post("/drone-position", (req, res) => {
    latestPosition = req.body; 
    console.log("Position reçue :", latestPosition);
    res.sendStatus(200);
});

// Nouveau endpoint pour renvoyer la dernière position
app.get("/drone-position", (req, res) => {
    if (latestPosition) {
        res.json(latestPosition);
    } else {
        res.status(204).send(); // Pas de contenu si aucune position reçue
    }
});

// Endpoint pour recevoir une mission (type waypoints)
app.post("/drone-mission", (req, res) => {
    const { sysid } = req.body;
    if (!sysid) {
        return res.status(400).send("sysid manquant");
    }
    missions[sysid] = {
        ...req.body,
        receivedAt: Date.now()
    };
    fs.writeFileSync(MISSION_FILE, JSON.stringify(missions));
    console.log("Mission reçue pour sysid", sysid, ":", req.body);
    res.sendStatus(200);
});

// Endpoint pour fournir la mission d'un sysid
app.get("/drone-mission/:sysid", (req, res) => {
    const sysid = req.params.sysid;
    if (missions[sysid]) {
        res.json(missions[sysid]);
    } else {
        res.status(204).send();
    }
});

app.get("/drone-missions/recent", (req, res) => {
    const now = Date.now();
    const fourHours = 4 * 60 * 60 * 1000;
    const recentMissions = Object.values(missions)
        .filter(m => m.receivedAt && (now - m.receivedAt) <= fourHours);
    res.json(recentMissions);
});

app.use(express.static("public")); // Sert tout ce qui se trouve dans /public

app.listen(process.env.PORT || 3000, () => {
    console.log("Serveur HTTP prêt sur le port", process.env.PORT || 3000);
});
