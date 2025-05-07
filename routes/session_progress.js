const express = require('express');
const router = express.Router();
const pool = require('../db');

// Get all modules (normal and debt) for a student
router.get('/:student_id/modules', async (req, res) => {
  try {
    const { student_id } = req.params;

    // First get student's promotion_id
    const studentQuery = await pool.query(
      'SELECT promotion_id FROM public."Student" WHERE matricule = $1',
      [student_id]
    );

    if (studentQuery.rows.length === 0) {
      return res.status(404).json({ error: 'Student not found' });
    }

    const promotion_id = studentQuery.rows[0].promotion_id;

    // Get normal modules (based on promotion)
    const normalModulesQuery = await pool.query(
      `SELECT 
        m.id AS module_id,
        m.name AS module_name,
        'normal' AS module_type
       FROM public."Module" m
       WHERE m.promotion_id = $1
       ORDER BY m.name`,
      [promotion_id]
    );

    // Get debt modules
    const debtModulesQuery = await pool.query(
      `SELECT 
        m.id AS module_id,
        m.name AS module_name,
        'debt' AS module_type
       FROM public."Student_DebtModules" sdm
       JOIN public."Module" m ON sdm.module_id = m.id
       WHERE sdm."Student_id" = $1
       ORDER BY m.name`,
      [student_id]
    );

    // Combine results
    const response = {
      normal_modules: normalModulesQuery.rows,
      debt_modules: debtModulesQuery.rows
    };

    res.json(response);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:studentId/modules/:moduleId/sessions', async (req, res) => {
  const { studentId, moduleId } = req.params;

  try {
    const query = `
      WITH 
      -- Get all sessions for the student (both group-based and section-based)
      student_sessions AS (
        -- Group-based sessions (PW/DW)
        SELECT 
          s.id AS session_id,
          s."Module_id",
          s."type",
          s.prof_id,
          s.group_id,
          NULL AS section_id
        FROM public."session" s
        JOIN public."Student" st ON st.group_id = s.group_id
        WHERE st.matricule = $1
        AND s."Module_id" = $2
        
        UNION
        
        -- Section-based sessions (Cours)
        SELECT 
          s.id AS session_id,
          s."Module_id",
          s."type",
          s.prof_id,
          NULL AS group_id,
          s.section_id
        FROM public."session" s
        JOIN public."Student" st ON st.promotion_id = (
          SELECT promotion_id FROM public."section" WHERE id = s.section_id
        )
        WHERE st.matricule = $1
        AND s."Module_id" = $2
        AND s.section_id IS NOT NULL
      ),

      -- Calculate title progress for each session
      title_progress AS (
        SELECT 
          s.session_id,
          s."Module_id",
          s."type",
          COUNT(t.id) AS total_titles,
          SUM(CASE WHEN p.is_completed THEN 1 ELSE 0 END) AS completed_titles,
          CASE 
            WHEN COUNT(t.id) > 0 THEN 
              ROUND((SUM(CASE WHEN p.is_completed THEN 1 ELSE 0 END) * 100.0) / COUNT(t.id))
            ELSE 0 
          END AS progress_percentage
        FROM student_sessions s
        JOIN public."ModuleTitle " t ON t.module_id = s."Module_id" AND t."type" = s."type"
        LEFT JOIN public."ProfessorTitleProgress" p ON p.title_id = t.id AND p.session_id = s.session_id
        GROUP BY s.session_id, s."Module_id", s."type"
      )

      -- Final result with all required information
      SELECT 
        m."name" AS module_name,
        ss."type" AS session_type,
        CONCAT(p.firstname, ' ', p.lastname) AS professor_name,
        tp.progress_percentage,
        ss.session_id,
        tp.completed_titles,
        tp.total_titles
      FROM student_sessions ss
      JOIN public."Module" m ON m.id = ss."Module_id"
      JOIN public."Professor" p ON p.matricule = ss.prof_id
      LEFT JOIN title_progress tp ON tp.session_id = ss.session_id
      ORDER BY ss."type", ss.session_id;
    `;

    const { rows } = await pool.query(query, [studentId, moduleId]);

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No sessions found for this student and module combination'
      });
    }

    res.json({
      success: true,
      data: rows
    });

  } catch (error) {
    console.error('Error fetching student sessions:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while fetching student sessions',
      error: error.message
    });
  }
});


router.get('/:studentId/modules/:moduleId/debt-sessions', async (req, res) => {
  const { studentId, moduleId } = req.params;

  try {

    const query = `
    WITH 
    -- Get all debt sessions for the student and module
    student_debt_sessions AS (
      SELECT 
        ds.session_id,
        s."Module_id",
        s."type",
        s.prof_id,
        s.group_id,
        s.section_id,
        true AS is_debt_session
      FROM public."Student_DebtSessions" ds
      JOIN public."session" s ON ds.session_id = s.id
      JOIN public."Student_DebtModules" dm ON dm."Student_id" = ds.student_id 
        AND dm.module_id = s."Module_id"
      WHERE ds.student_id = $1
      AND s."Module_id" = $2
    ),
    
    -- Get all course sessions for the module
    all_course_sessions AS (
      SELECT 
        s.id AS session_id,
        s."Module_id",
        s."type",
        s.prof_id,
        s.group_id,
        s.section_id,
        false AS is_debt_session
      FROM public."session" s
      WHERE s."Module_id" = $2
      AND s."type" = 'cours'
    ),
  
    -- Check if we need to include fallback course sessions
    should_include_courses AS (
      SELECT NOT EXISTS (
        SELECT 1 FROM student_debt_sessions WHERE "type" = 'cours'
      ) AS include_fallback
    ),
  
    -- Combine sessions based on conditions
    combined_sessions AS (
      -- Always include debt sessions
      SELECT * FROM student_debt_sessions
      
      UNION ALL
      
      -- Include course sessions only if no debt course sessions exist
      SELECT * FROM all_course_sessions
      WHERE (SELECT include_fallback FROM should_include_courses)
    ),
  
    -- Calculate title progress for each session
    title_progress AS (
      SELECT 
        s.session_id,
        s."Module_id",
        s."type",
        COUNT(t.id) AS total_titles,
        SUM(CASE WHEN p.is_completed THEN 1 ELSE 0 END) AS completed_titles,
        CASE 
          WHEN COUNT(t.id) > 0 THEN 
            ROUND((SUM(CASE WHEN p.is_completed THEN 1 ELSE 0 END) * 100.0 / COUNT(t.id)), 0)
          ELSE 0 
        END AS progress_percentage,
        s.is_debt_session
      FROM combined_sessions s
      JOIN public."ModuleTitle " t ON t.module_id = s."Module_id" AND t."type" = s."type"
      LEFT JOIN public."ProfessorTitleProgress" p ON p.title_id = t.id AND p.session_id = s.session_id
      GROUP BY s.session_id, s."Module_id", s."type", s.is_debt_session
    )
  
    -- Final result with all required information
    SELECT 
      m."name" AS module_name,
      cs."type" AS session_type,
      CONCAT(p.firstname, ' ', p.lastname) AS professor_name,
      tp.progress_percentage,
      cs.session_id,
      tp.completed_titles,
      tp.total_titles,
      tp.is_debt_session
    FROM combined_sessions cs
    JOIN public."Module" m ON m.id = cs."Module_id"
    JOIN public."Professor" p ON p.matricule = cs.prof_id
    LEFT JOIN title_progress tp ON tp.session_id = cs.session_id
    ORDER BY 
      cs.is_debt_session DESC,  -- Show debt sessions first
      cs."type", 
      cs.session_id;
  `;
    const { rows } = await pool.query(query, [studentId, moduleId]);

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No sessions found for this student and module combination'
      });
    }

    res.json({
      success: true,
      data: rows
    });

  } catch (error) {
    console.error('Error fetching student debt sessions:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while fetching student debt sessions',
      error: error.message
    });
  }
});




module.exports = router;