const express = require('express');
const router = express.Router();
const pool = require('../db');

// Get student's debt modules
router.get('/:student_id/debt-modules', async (req, res) => {
  try {
    const { student_id } = req.params;
    const result = await pool.query(
      `SELECT 
        sdm."Student_id",
        sdm.module_id,
        m."name" AS module_name,
        sp."name" AS specialty_name,
        CASE 
          WHEN EXTRACT(MONTH FROM sem."StartDate") BETWEEN 9 AND 12 THEN 'Fall ' || EXTRACT(YEAR FROM sem."StartDate")
          ELSE 'Spring ' || EXTRACT(YEAR FROM sem."StartDate")
        END AS semester_name,
        l."level" AS study_level
      FROM 
        public."Student_DebtModules" sdm
      JOIN 
        public."Module" m ON sdm.module_id = m.id
      JOIN 
        public."Promotion" p ON m.promotion_id = p.id
      JOIN 
        public."Specialty" sp ON p.specialty_id = sp.code
      JOIN 
        public."Semester" sem ON m.semester_id = sem." SemesterID"
      JOIN 
        public."level" l ON p.level_id = l."level"
      WHERE 
        sdm."Student_id" = $1`,
      [student_id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get available makeup sessions for a module
router.get('/:student_id/available-sessions/:module_id/:session_type', async (req, res) => {
  try {
    const { student_id, module_id, session_type } = req.params;
    
    // First check if student already has this session type
    const existingSessionCheck = await pool.query(
      `SELECT 1 FROM public."Student_DebtSessions" sds
       JOIN public."session" s ON sds.session_id = s.id
       WHERE sds.student_id = $1 AND s."Module_id" = $2 AND s."type" = $3`,
      [student_id, module_id, session_type]
    );

    if (existingSessionCheck.rows.length > 0) {
      return res.status(200).json({ 
        message: 'You already have a session for this module',
        hasExistingSession: true 
      });
    }

    // If no existing session, proceed with original query
    const result = await pool.query(
      `WITH student_debt_sessions AS (
         SELECT s2.id, s2."type", dt2."day", dt2."startTime", dt2."endTime",s2."Module_id"
         FROM public."Student_DebtSessions" sds
         JOIN public."session" s2 ON sds.session_id = s2.id
         JOIN public."dayTime" dt2 ON s2.time_id = dt2.id
         WHERE sds.student_id = $3
       )
       SELECT 
         s.id AS session_id,
         s."type" AS session_type,
         dt."day",
         dt."startTime",
         dt."endTime",
         m."name" AS module_name,
         r.id AS room_id,
         r."type" AS room_type,
         r.capacity,
         CONCAT(p.firstname, ' ', p.lastname) AS professor_name
       FROM 
         public."session" s
       JOIN 
         public."dayTime" dt ON s.time_id = dt.id
       JOIN 
         public."Module" m ON s."Module_id" = m.id
       JOIN 
         public."Room" r ON s.room_id = r.id
       LEFT JOIN 
         public."Professor" p ON s.prof_id = p.matricule
       WHERE 
         s."Module_id" = $1
         AND s."type" = $2
         AND NOT EXISTS (
           SELECT 1 FROM student_debt_sessions sds 
           WHERE sds."Module_id"=$1 AND sds."type" = $2 
         )
         AND NOT EXISTS (
           SELECT 1 FROM student_debt_sessions sds
           WHERE sds."day" = dt."day"
           AND sds."startTime" = dt."startTime"
           AND sds."endTime" = dt."endTime"
         )
         AND NOT EXISTS (
           SELECT 1 
           FROM public."session" sn
           JOIN public."dayTime" dtn ON sn.time_id = dtn.id
           JOIN public."Student" st ON sn.group_id = st.group_id
           WHERE 
             st.matricule = $3
             AND dtn.id = dt.id
         )
       ORDER BY 
         dt."day", 
         dt."startTime"`,
      [module_id, session_type, student_id]
    );

    if (result.rows.length === 0) {
      return res.status(200).json({ 
        message: 'No available sessions found for you', 
        hasExistingSession: false 
      });
    }

    res.json({ 
      sessions: result.rows,
      hasExistingSession: false 
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

function formatTime(timeArray) {
  return timeArray[0].substring(0, 5); // Format HH:MM
}
// Register for a makeup session
router.post('/:student_id/register-session', async (req, res) => {
  try {
    const { student_id } = req.params;
    const { session_id} = req.body;

    // Start transaction
    await pool.query('BEGIN');

    // Add to debt sessions table
    await pool.query(
      'INSERT INTO public."Student_DebtSessions" (student_id, session_id) VALUES ($1, $2)',
      [student_id, session_id]
    );
    // Commit transaction
    await pool.query('COMMIT');

    res.json({ success: true, message: 'Session registered successfully' });
  } catch (err) {
    // Rollback on error
    await pool.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;