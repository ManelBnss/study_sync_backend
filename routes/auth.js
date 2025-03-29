const express = require("express");
const pool = require("../db"); // Connexion à PostgreSQL
const jwt = require("jsonwebtoken");
require("dotenv").config();

const router = express.Router();

// Route de connexion (login) avec matricule et mot de passe
router.post("/login", async (req, res) => {
    const { matricule, password } = req.body;

    if (!matricule || !password) {
        return res.status(400).json({ message: "Matricule et mot de passe requis" });
    }

    try {
        // Vérifier si l'étudiant existe
        const result = await pool.query(
            'SELECT * FROM public."Student" WHERE matricule = $1',
            [matricule]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({ message: "Matricule incorrect" });
        }

        const student = result.rows[0];

        // Vérification du mot de passe (ajoute bcrypt si tu hashes le mot de passe)
        if (student.password !== password) {
            return res.status(401).json({ message: "Mot de passe incorrect" });
        }

        // Générer un token JWT
        const token = jwt.sign(
            { matricule: student.matricule },
            process.env.JWT_SECRET,
            { expiresIn: "1h" }
        );

        res.json({ token, user: { matricule: student.matricule, firstname: student.firstname, lastname: student.lastname } });

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Erreur serveur" });
    }
}


);


// 🔹 Route pour récupérer le profil d'un étudiant via son matricule
router.get("/profile/:matricule", async (req, res) => {
    const { matricule } = req.params;
    console.log("Matricule reçu :", matricule);

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
                s.matricule = $1;`,
            [matricule]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ message: "Étudiant non trouvé" });
        }

        res.json(result.rows[0]);

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Erreur serveur" });
    }
});




module.exports = router;

