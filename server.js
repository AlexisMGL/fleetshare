const express = require("express");
const app = express();
app.use(express.json());

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

app.use(express.static("public")); // Sert tout ce qui se trouve dans /public

app.listen(process.env.PORT || 3000, () => {
    console.log("Serveur HTTP prêt sur le port", process.env.PORT || 3000);
});
