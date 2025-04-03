const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
require("dotenv").config();

const app = express();

// Middleware
app.use(cors());
app.use(bodyParser.json());

// Importation des routes
const authRoutes1 = require("./routes/auth");
const authRoutes2 = require("./routes/debtSessions");
app.use('/auth', authRoutes1);  
app.use('/debtSessions', authRoutes2);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Serveur en cours d'exécution sur le port ${PORT}`);
});


