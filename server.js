const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
require("dotenv").config();

const app = express();

// Middleware



app.use(cors({
  origin: true, // Allows all origins (for debugging)
  credentials: true
}));
app.use(bodyParser.json());
// Importation des routes
const authRoutes1 = require("./routes/auth");
const authRoutes2 = require("./routes/debtSessions");

const authRoutes = require('./routes/profauth');
const authRoutes4=require("./routes/professormodules");
const routes5=require('./routes/professorModuleprogress');
const routes6=require('./routes/makeup');
const routes7=require('./routes/schedule');
const routes8=require('./routes/session_progress');

app.use('/auth', authRoutes1);  
app.use('/debtSessions', authRoutes2);

app.use('/profauth', authRoutes);
app.use('/professormodules', authRoutes4);
app.use('/professorModuleprogress',routes5);
app.use('/makeup',routes6);
app.use('/schedule',routes7);
app.use('/session_progress',routes8);




const PORT = process.env.PORT || 5000;
app.listen(5000, '0.0.0.0', () => {
    console.log('Server running on http://0.0.0.0:5000');
  });
  


