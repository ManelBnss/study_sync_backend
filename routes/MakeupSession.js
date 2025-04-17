const express = require('express');
const router = express.Router();
const pool = require('../db');


// 1. Définissez d'abord toutes les fonctions helper
async function getAbsentSessionInfo(attendanceId) {
  const query = `
    SELECT a.student_id, s."Module_id" as module_id, s."type", a.session_id
    FROM public."Attendance" a
    JOIN public."session" s ON a.session_id = s.id
    WHERE a.id = $1 AND a.present = false AND a.ismarkup = false
  `;
  const result = await pool.query(query, [attendanceId]);
  return result.rows[0] || null;
}

async function findPotentialSessions(moduleId, sessionType, absentSessionId) {
  const query = `
    SELECT s.id as session_id, s.time_id, s.room_id, s.group_id, s.section_id, s."type", 
           s."Module_id", s.ismarkup, dt."day", dt."startTime", dt."endTime",
           r.capacity, r."type" as room_type
    FROM public."session" s
    JOIN public."dateTime" dt ON s.time_id = dt.id
    JOIN public."Room" r ON s.room_id = r."id"
    WHERE s."Module_id" = $1 AND s."type" = $2 AND s.id != $3
  `;
  const result = await pool.query(query, [moduleId, sessionType, absentSessionId]);
  return result.rows;
}

function createDateTime(date, time) {
  if (Array.isArray(time)) time = time[0];
  if (typeof time !== 'string') throw new Error(`Format de temps non valide: ${JSON.stringify(time)}`);
  
  const [hours, minutes, seconds] = time.split(':').map(Number);
  const result = new Date(date);
  result.setHours(hours, minutes || 0, seconds || 0);
  return result;
}

async function getAllStudentSessions(studentId) {
  const queries = [
    `SELECT s.id, dt."day", dt."startTime"::varchar as "startTime", dt."endTime"::varchar as "endTime"
     FROM public."session" s JOIN public."dateTime" dt ON s.time_id = dt.id
     JOIN public."Group" g ON s.group_id = g.id
     JOIN public."Student" st ON g.id = st.group_id
     WHERE st.matricule = $1`,
    `SELECT s.id, dt."day", dt."startTime"::varchar as "startTime", dt."endTime"::varchar as "endTime"
     FROM public."Student_DebtSessions" ds
     JOIN public."session" s ON ds.session_id = s.id
     JOIN public."dateTime" dt ON s.time_id = dt.id
     WHERE ds.student_id = $1`
  ];

  let allSessions = [];
  for (const query of queries) {
    const result = await pool.query(query, [studentId]);
    allSessions = allSessions.concat(result.rows);
  }
  return allSessions;
}

async function filterStudentSchedule(studentId, sessions) {
  const studentSessions = await getAllStudentSessions(studentId);
  return sessions.filter(session => {
    try {
      const sessionStart = createDateTime(session.day, session.startTime);
      const sessionEnd = createDateTime(session.day, session.endTime);
      
      return !studentSessions.some(studentSession => {
        const studentStart = createDateTime(studentSession.day, studentSession.startTime);
        const studentEnd = createDateTime(studentSession.day, studentSession.endTime);
        return sessionStart < studentEnd && sessionEnd > studentStart;
      });
    } catch (error) {
      console.error('Erreur avec la session:', session.session_id, error);
      return false;
    }
  });
}

async function checkRoomAvailability(session) {
  // 1. Compter les étudiants du groupe assigné
  const groupStudentsQuery = `
    SELECT COUNT(*) 
    FROM public."Student" s
    JOIN public."session" sess ON s.group_id = sess.group_id
    WHERE sess.id = $1
  `;
  const groupCount = await pool.query(groupStudentsQuery, [session.session_id]);
  
  // 2. Compter les étudiants en rattrapage
  const makeupCount = await pool.query(
    `SELECT COUNT(*) FROM public."Student_MakeupSession" WHERE session_id = $1`,
    [session.session_id]
  );
  
  // 3. Compter les étudiants avec dette
  const debtCount = await pool.query(
    `SELECT COUNT(*) FROM public."Student_DebtSessions" WHERE session_id = $1`,
    [session.session_id]
  );
  
  const totalStudents = 
    parseInt(groupCount.rows[0].count) + 
    parseInt(makeupCount.rows[0].count) + 
    parseInt(debtCount.rows[0].count);
  
  return totalStudents < session.capacity;
}

async function filterAvailableSessions(sessions) {
  const availableSessions = [];
  
  for (const session of sessions) {
    if (session.type === 'pw' || await checkRoomAvailability(session)) {
      availableSessions.push(session);
    }
  }
  
  return availableSessions;
}

// Modifiez la route principale
router.get('/makeup-sessions/:attendanceId', async (req, res) => {
  try {
    const attendanceId = req.params.attendanceId;
    
    const absentSession = await getAbsentSessionInfo(attendanceId);
    if (!absentSession) {
      return res.status(404).json({ message: 'Absence non trouvée ou déjà rattrapée' });
    }

    const potentialSessions = await findPotentialSessions(
      absentSession.module_id, 
      absentSession.type,
      absentSession.session_id
    );
    
    const filteredSessions = await filterStudentSchedule(absentSession.student_id, potentialSessions);
    
    // Nouveau filtre de capacité
    const availableSessions = await filterAvailableSessions(filteredSessions);
    
    res.json({
      studentId: absentSession.student_id,
      moduleId: absentSession.module_id,
      originalSessionId: absentSession.session_id,
      availableSessions: availableSessions
    });
    
  } catch (error) {
    console.error('Erreur:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;