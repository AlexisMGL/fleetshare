const express = require("express");
const app = express();
app.use(express.json());

app.post("/drone-position", (req, res) => {
    console.log("Position reçue:", req.body);
    res.sendStatus(200);
});

app.listen(3000, () => console.log("Serveur HTTP prêt sur le port 3000"));
