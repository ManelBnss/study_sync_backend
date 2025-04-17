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
const authRoutes3 = require("./routes/MakeupSession");
app.use('/auth', authRoutes1);  
app.use('/debtSessions', authRoutes2);
app.use('/MakeupSession', authRoutes3);




const PORT = process.env.PORT || 5000;
app.listen(5000, '0.0.0.0', () => {
    console.log('Server running on http://0.0.0.0:5000');
  });
  


