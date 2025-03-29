const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
require("dotenv").config();

const app = express();

// Middleware
app.use(cors());
app.use(bodyParser.json());

// Importation des routes
const authRoutes = require("./routes/auth");
app.use("/auth", authRoutes);  // ✅ Ça doit être "/auth" et non "/routes/auth"

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Serveur en cours d'exécution sur le port ${PORT}`);
});


