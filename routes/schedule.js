const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

// Route to get student weekly schedule
router.get('/schedule/:studentId', async (req, res) => {
    try {
      const { studentId } = req.params;
      const { weekOffset = 0 } = req.query; // 0 = current week, 1 = next week, -1 = previous week
      
      // Convert weekOffset to number
      const weekOffsetNum = parseInt(weekOffset) || 0;
  
      // Get week dates based on offset (Saturday to Thursday)
      const currentDate = new Date();
      currentDate.setDate(currentDate.getDate() + weekOffsetNum * 7);
      const currentDay = currentDate.getDay();
      
      const saturday = new Date(currentDate);
      saturday.setDate(currentDate.getDate() - (currentDay + 1) % 7);
      saturday.setHours(0, 0, 0, 0);
      
      const thursday = new Date(saturday);
      thursday.setDate(saturday.getDate() + 5);
      thursday.setHours(23, 59, 59, 999);
  
      const startDate = formatDate(saturday);
      const endDate = formatDate(thursday);
  
      // First, verify student exists and get their info
      const studentQuery = `
        SELECT s.matricule, s.group_id as student_group_id, s.promotion_id, 
               g.section_id, p.id as promotion_id, p.level_id, p.specialty_id
        FROM public."Student" s
        JOIN public."Group" g ON s.group_id = g.id
        JOIN public."Promotion" p ON s.promotion_id = p.id
        WHERE s.matricule = $1
      `;
      
      const studentRes = await pool.query(studentQuery, [studentId]);
      
      if (studentRes.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Student not found'
        });
      }
  
      const student = studentRes.rows[0];
      
      // Main query with proper syntax
      const query = `
        WITH 
        -- Get all session occurrences in date range with proper day names
        week_occurrences AS (
          SELECT 
            so.id as occurrence_id,
            so.date,
            INITCAP(TRIM(dt.day)) as standardized_day,
            dt."startTime",
            dt."endTime",
            s.id as session_table_id,
            s."type" as session_type,
            s."Module_id",
            m."name" as module_name,
            r.id as room_id,
            r."type" as room_type,
            p.firstname || ' ' || p.lastname as professor_name,
            so.is_compensation,
            so.comdaytimid,
            so.compenroomid,
            so.profabsence,
            s.group_id as session_group_id,
            s.section_id
          FROM public."sessionoccurrence" so
          JOIN public."session" s ON so.session_id = s.id
          JOIN public."dayTime" dt ON s.time_id = dt.id
          JOIN public."Module" m ON s."Module_id" = m.id
          JOIN public."Room" r ON s.room_id = r.id
          JOIN public."Professor" p ON s.prof_id = p.matricule
          WHERE so.date BETWEEN $1::date AND $2::date
        ),
        
        -- Normal sessions for student's group
        group_sessions AS (
          SELECT wo.*, 'group' as session_scope
          FROM week_occurrences wo
          WHERE wo.session_group_id = $3
            AND wo.session_type IN ('pw', 'dw')
        ),
        
        -- Normal sessions for student's section
        section_sessions AS (
          SELECT wo.*, 'section' as session_scope
          FROM week_occurrences wo
          WHERE wo.section_id = $4
            AND wo.session_type NOT IN ('pw', 'dw')
        ),
        
        -- Debt sessions
        debt_sessions AS (
          SELECT wo.*, 'debt' as session_scope
          FROM week_occurrences wo
          JOIN public."Student_DebtSessions" ds ON wo.session_table_id = ds.session_id
          WHERE ds.student_id = $5
        ),
        
        -- Makeup sessions
        makeup_sessions AS (
          SELECT wo.*, 'makeup' as session_scope
          FROM week_occurrences wo
          JOIN public."Student_MakeupSession" ms ON wo.occurrence_id = ms.sessionoccur_id
          WHERE ms."Student_id" = $5
        )
        
        -- Combine all relevant sessions
        SELECT 
          o.occurrence_id,
          o.date,
          o.standardized_day as day,
          o."startTime",
          o."endTime",
          o.session_table_id as session_id,
          o.session_type,
          o."Module_id",
          o.module_name,
          o.room_id,
          o.room_type,
          o.professor_name,
          o.is_compensation,
          o.comdaytimid,
          o.compenroomid,
          o.profabsence,
          CASE WHEN d.session_id IS NOT NULL THEN true ELSE false END as is_debt,
          CASE WHEN m.sessionoccur_id IS NOT NULL THEN true ELSE false END as is_makeup,
          o.session_scope
        FROM (
          SELECT * FROM group_sessions
          UNION ALL
          SELECT * FROM section_sessions
          UNION ALL
          SELECT * FROM debt_sessions
          UNION ALL
          SELECT * FROM makeup_sessions
        ) o
        LEFT JOIN public."Student_DebtSessions" d ON o.session_table_id = d.session_id AND d.student_id = $5
        LEFT JOIN public."Student_MakeupSession" m ON o.occurrence_id = m.sessionoccur_id AND m."Student_id" = $5
        ORDER BY o.date, o."startTime"
      `;
  
      const { rows } = await pool.query(query, [
        startDate, 
        endDate,
        student.student_group_id,
        student.section_id,
        studentId
      ]);
  
      // Process results with standardized day names
      const schedule = rows.map(session => ({
        id: session.occurrence_id,
        date: formatDate(session.date),
        day: session.day,
        startTime: `${formatTime(session.startTime)}`,
        endTime: `${formatTime(session.endTime)}`,
        moduleId: session.Module_id,
        moduleName: session.module_name,
        sessionId: session.session_id,
        sessionType: session.session_type,
        roomId: session.room_id,
        roomType: session.room_type,
        professor: session.professor_name,
        isCanceled: session.profabsence,
        isCompensation: session.is_compensation,
        isDebt: session.is_debt,
        isMakeup: session.is_makeup,
        sessionScope: session.session_scope,
        color: getSessionColor(session)
      }));
  
      // Group by standardized day names
      const groupedSchedule = groupByDay(schedule);
  
      res.json({
        success: true,
        schedule: groupedSchedule,
        weekRange: { 
          start: startDate, 
          end: endDate,
          weekOffset: weekOffsetNum
        },
        debug: {
          studentInfo: student,
          sessionsFound: rows.length
        }
      });
  
    } catch (error) {
      console.error('Error:', error);
      res.status(500).json({
        success: false,
        message: 'Server error',
        error: error.message,
        stack: error.stack
      });
    }
  });
  
  function getSessionColor(session) {
    if (session.profabsence) return '#fed3bf'; // Red for canceled
    if (session.is_compensation) return '#edd9fc '; // Purple for compensation
    if (session.is_makeup) return '#faddae '; // Orange for makeup
    if (session.is_debt) return '#def2fa'; // Blue for debt
    return '#ffffff'; // Green for normal
  }
  
  function createEmptySchedule() {
    return {
      "Saturday": [],
      "Sunday": [],
      "Monday": [],
      "Tuesday": [],
      "Wednesday": [],
      "Thursday": []
    };
  }
  

  function formatDate(date) {
    // Get date components in local time to avoid timezone shifting
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  function formatTime(timeArray) {
    return timeArray[0].substring(0, 5); // Format HH:MM
}
  
  function groupByDay(sessions) {
    const dayMap = {
      'sat': 'Saturday',
      'saturday': 'Saturday',
      'sun': 'Sunday',
      'sunday': 'Sunday',
      'mon': 'Monday',
      'monday': 'Monday',
      'tue': 'Tuesday',
      'tuesday': 'Tuesday',
      'wed': 'Wednesday',
      'wednesday': 'Wednesday',
      'thu': 'Thursday',
      'thursday': 'Thursday'
    };
  
    const days = ['Saturday', 'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday'];
    const grouped = {};
    
    days.forEach(day => {
      grouped[day] = [];
    });
  
    sessions.forEach(session => {
      const lowerDay = session.day.toLowerCase();
      const standardizedDay = dayMap[lowerDay] || session.day;
      
      if (days.includes(standardizedDay)) {
        grouped[standardizedDay].push(session);
      } else {
        console.warn(`Unexpected day name: ${session.day}`);
      }
    });
  
    return grouped;
  }

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
            s.section_id
          FROM public."Student_DebtSessions" ds
          JOIN public."session" s ON ds.session_id = s.id
          JOIN public."Student_DebtModules" dm ON dm."Student_id" = ds.student_id 
            AND dm.module_id = s."Module_id"
          WHERE ds.student_id = $1
          AND s."Module_id" = $2
        ),
  
        -- Calculate title progress for each debt session
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
          FROM student_debt_sessions s
          JOIN public."ModuleTitle " t ON t.module_id = s."Module_id" AND t."type" = s."type"
          LEFT JOIN public."ProfessorTitleProgress" p ON p.title_id = t.id AND p.session_id = s.session_id
          GROUP BY s.session_id, s."Module_id", s."type"
        )
  
        -- Final result with all required information
        SELECT 
          m."name" AS module_name,
          ds."type" AS session_type,
          CONCAT(p.firstname, ' ', p.lastname) AS professor_name,
          tp.progress_percentage,
          ds.session_id,
          tp.completed_titles,
          tp.total_titles,
          true AS is_debt_session  -- Flag to identify debt sessions
        FROM student_debt_sessions ds
        JOIN public."Module" m ON m.id = ds."Module_id"
        JOIN public."Professor" p ON p.matricule = ds.prof_id
        LEFT JOIN title_progress tp ON tp.session_id = ds.session_id
        ORDER BY ds."type", ds.session_id;
      `;
  
      const { rows } = await pool.query(query, [studentId, moduleId]);
  
      if (rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'No debt sessions found for this student and module combination'
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
  

  // Ajoutez cette route dans votre schedule.js
router.get('/:studentId/absence-percentage/:semesterId', async (req, res) => {
  try {
    const { studentId, semesterId } = req.params;

    const query = `
      WITH 
      semester_sessions AS (
        SELECT so.id as occurrence_id, s.id as session_id
        FROM sessionoccurrence so
        JOIN session s ON so.session_id = s.id
        JOIN "Module" m ON s."Module_id" = m.id
        JOIN "Semester" sem ON m.semester_id = sem." SemesterID"
        WHERE sem." SemesterID" = $1
      ),
      total_sessions AS (
        SELECT COUNT(*) as total
        FROM semester_sessions ss
        JOIN "Attendance" a ON ss.occurrence_id = a.sessionoccur_id
        WHERE a.student_id = $2
      ),
      absent_sessions AS (
        SELECT COUNT(*) as absent
        FROM semester_sessions ss
        JOIN "Attendance" a ON ss.occurrence_id = a.sessionoccur_id
        WHERE a.student_id = $2
        AND a.present = false
      )
      SELECT 
        ts.total as total_sessions,
        ab.absent as absent_sessions,
        CASE 
          WHEN ts.total > 0 THEN ROUND((ab.absent * 100.0) / ts.total, 2)
          ELSE 0 
        END as absence_percentage
      FROM total_sessions ts, absent_sessions ab;
    `;

    const { rows } = await pool.query(query, [semesterId, studentId]);

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No attendance data found for this student and semester'
      });
    }

    res.json({
      success: true,
      data: rows[0]
    });

  } catch (error) {
    console.error('Error calculating absence percentage:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while calculating absence percentage',
      error: error.message
    });
  }
});


module.exports = router;