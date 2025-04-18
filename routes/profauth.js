const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db');;
require('dotenv').config();

// Enhanced login route (handles both matricule and email)
router.post('/login', async (req, res) => {
  const { identifier, password } = req.body;

  try {
    // 1. Check if identifier is matricule or email
    const isMatricule = /^[A-Za-z0-9]{1,20}$/.test(identifier);
    const queryText = isMatricule
      ? 'SELECT * FROM "Professor" WHERE matricule = $1'
      : 'SELECT * FROM "Professor" WHERE email = $1';

    // 2. Fetch professor
    const result = await pool.query(queryText, [identifier]);

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials 1' });
    }

    const professor = result.rows[0];

    // 3. Compare passwords
   /* const isMatch = await bcrypt.compare(password, professor.password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid credentials 2 ' });
    }*/
    if (password !== professor.password) {
        return res.status(401).json({ message: 'Invalid credentials2' });
      }
    // 4. Generate JWT (with role if needed)
    const token = jwt.sign(
      { 
        matricule: professor.matricule,
        email: professor.email 
      },
      process.env.JWT_SECRET || 'your_secret_key',
      { expiresIn: '1h' }
    );

    res.json({
      token,
      professor: {
        matricule: professor.matricule,
        firstname: professor.firstname,
        lastname: professor.lastname,
        email: professor.email
      }
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});



module.exports = router;