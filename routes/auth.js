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
        `SELECT 'student' as role, matricule, firstname, lastname, NULL as email, password 
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

  router.get('/profile/:matricule', async (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const { matricule } = req.params;

    try {
        // Verify token
        if (!token) {
            return res.status(401).json({ message: 'Authorization token required' });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        // Get student profile with all required fields
        const result = await pool.query(`
            SELECT 
                s.matricule, 
                s.firstname as firstname, 
                s.lastname as lastname,
                sp.name as specialty_name,
                p.level_id as level,
                sec.name as section_name,
                g.name as group_name
            FROM "Student" s
            JOIN "Promotion" p ON s.promotion_id = p.id
            LEFT JOIN "Specialty" sp ON p.specialty_id = sp.code
            JOIN "Group" g ON s.group_id = g.id
            JOIN "section" sec ON g.section_id = sec.id
            WHERE s.matricule = $1
        `, [matricule]);

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Student not found' });
        }

        const studentData = result.rows[0];
        
        res.json({
            matricule: studentData.matricule,
            firstname: studentData.firstname,
            lastname: studentData.lastname,
            specialty_name: studentData.specialty_name,
            level: studentData.level,
            section_name: studentData.section_name,
            group_name: studentData.group_name
        });

    } catch (err) {
        if (err.name === 'JsonWebTokenError') {
            return res.status(401).json({ message: 'Invalid token' });
        }
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
});





module.exports = router;