const express = require('express');
const jwt = require('jsonwebtoken');
const pool = require('../db');
require('dotenv').config();

const router = express.Router();

// Middleware d'authentification
const authenticate = (req, res, next) => {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) return res.status(401).json({ message: "Non autorisé" });

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded;
        next();
    } catch (err) {
        res.status(401).json({ message: "Token invalide" });
    }
};

// Récupérer le profil étudiant
router.get('/', authenticate, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT 
                s.matricule,
                s.firstname,
                s.lastname,
                sp.name AS specialty_name,
                l.level,
                sec.name AS section_name,
                g.name AS group_name
            FROM 
                public."Student" s
            JOIN 
                public."Promotion" p ON s.promotion_id = p.id
            JOIN 
                public."Specialty" sp ON p.specialty_id = sp.code
            JOIN 
                public.level l ON p.level_id = l.level
            JOIN 
                public."Group" g ON s.group_id = g.id
            JOIN 
                public.section sec ON g.section_id = sec.id
            WHERE 
                s.matricule = $1`,
            [req.user.matricule]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ message: "Étudiant introuvable" });
        }

        res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: "Erreur serveur" });
    }
});

module.exports = router;

