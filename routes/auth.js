const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db'); // Import pool directly
require('dotenv').config();

router.post('/login', async (req, res) => {
    const { matricule, password } = req.body;
    
    try {
      // Check both tables in one query
      const result = await pool.query(
        `SELECT 'professor' as role, matricule, firstname, lastname, email, password 
         FROM "Professor" WHERE matricule = $1
         UNION ALL
         SELECT 'student' as role, matricule, firstname, lastname, NULL as email, password 
         FROM "Student" WHERE matricule = $1`,
        [matricule]
      );
  
      if (result.rows.length === 0) {
        return res.status(401).json({ message: 'Invalid credentials' });
      }
  
      const user = result.rows[0];
      
      // Compare passwords (plain text for now)
      if (password !== user.password) {
        return res.status(401).json({ message: 'Invalid credentials' });
      }
  
      // Generate token
      const token = jwt.sign(
        {
          matricule: user.matricule,
          role: user.role
        },
        process.env.JWT_SECRET,
        { expiresIn: '24h' }
      );
  
      res.json({
        token,
        user: {
          matricule: user.matricule,
          firstname: user.firstname,
          lastname: user.lastname,
          role: user.role,
          ...(user.role === 'professor' && { email: user.email })
        }
      });
  
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: 'Server error' });
    }
  });
module.exports = router;