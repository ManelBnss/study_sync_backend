const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

/**
 * @route GET /api/students/:studentId/absent-sessions
 * @description Get all absent sessions for a student with session occurrence date
 */
router.get('/:studentId/absent-sessions-with-progress', async (req, res) => {
    try {
        const { studentId } = req.params;

        // Query to get all absent sessions with module progress
        const query = `WITH 
-- Get all absent sessions for the student
absent_sessions AS (
    SELECT 
        a.id AS attendance_id,
        so.id AS session_occurrence_id,
        s.id AS session_id,
        m.id AS module_id,
        m.name AS module_name,
        s.type AS session_type,
        dt.day,
        dt."startTime",
        dt."endTime",
        so.date AS session_date,
        CASE
            WHEN cr.request_id IS NOT NULL THEN cr.status
            WHEN a.ismakeup = true THEN 'Compensated'
            ELSE 'Absent'
        END AS status
    FROM public."Attendance" a
    JOIN public.sessionoccurrence so ON a.sessionoccur_id = so.id
    JOIN public."session" s ON so.session_id = s.id
    JOIN public."Module" m ON s."Module_id" = m.id
    JOIN public."dayTime" dt ON s.time_id = dt.id
    LEFT JOIN public."CompensationRequest" cr ON cr.attendence_id = a.id
    WHERE a.student_id = $1
    AND a.present = false
),

-- Calculate title progress for each session
title_progress AS (
    SELECT 
        s.id AS session_id,
        s."Module_id" AS module_id,
        COUNT(t.id) AS total_titles,
        SUM(CASE WHEN p.is_completed THEN 1 ELSE 0 END) AS completed_titles,
        CASE 
            WHEN COUNT(t.id) > 0 THEN 
                ROUND((SUM(CASE WHEN p.is_completed THEN 1 ELSE 0 END) * 100.0) / COUNT(t.id))
            ELSE 0 
        END AS title_progress_percentage
    FROM public."session" s
    JOIN public."ModuleTitle " t ON t.module_id = s."Module_id" AND t."type" = s."type"
    LEFT JOIN public."ProfessorTitleProgress" p ON p.title_id = t.id AND p.session_id = s.id
    WHERE s.id IN (SELECT session_id FROM absent_sessions)
    GROUP BY s.id, s."Module_id"
)

-- Combine absent sessions and title progress
SELECT 
    asn.*, 
    tp.total_titles,
    tp.completed_titles,
    tp.title_progress_percentage
FROM absent_sessions asn
LEFT JOIN title_progress tp ON asn.session_id = tp.session_id
ORDER BY asn.session_date DESC, asn."startTime" DESC;
`;

        const { rows } = await pool.query(query, [studentId]);

        // Format the results
        const formattedResults = rows.map(row => ({
            attendance_id: row.attendance_id,
            session_occurrence_id: row.session_occurrence_id,
            session_id: row.session_id,
            module_id: row.module_id,
            module_name: row.module_name,
            session_type: row.session_type,
            day: row.day,
            time: `${formatPgArrayTime(row.startTime)} - ${formatPgArrayTime(row.endTime)}`,
            date: formatDate(row.session_date), 
            status: row.status,
            progress: {
                percentage: row.title_progress_percentage || 0,
                completed_titles: row.completed_titles || 0,
                total_titles: row.total_titles || 0
            }
        }));

        // Group by module for better organization
        const groupedResults = formattedResults.reduce((acc, session) => {
            if (!acc[session.module_id]) {
                acc[session.module_id] = {
                    module_id: session.module_id,
                    module_name: session.module_name,
                    absent_sessions: []
                };
            }
            acc[session.module_id].absent_sessions.push(session);
            return acc;
        }, {});

        res.json({
            success: true,
            data: Object.values(groupedResults)
        });

    } catch (error) {
        console.error('Error fetching absent sessions with progress:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while fetching absent sessions with progress'
        });
    }
});

// Helper function to format PostgreSQL time array
function formatPgArrayTime(timeArray) {
    if (!timeArray || !timeArray[0]) return null;
    return timeArray[0].slice(0, 5); // Extract HH:MM from HH:MM:SS
}


function formatDate(dateString) {
    const date = new Date(dateString); // Convert to Date object
    const day = String(date.getDate()).padStart(2, '0'); // Ensure two digits
    const month = String(date.getMonth() + 1).padStart(2, '0'); // Months are 0-indexed
    const year = date.getFullYear();
    
    return `${day}/${month}/${year}`; // Format as DD/MM/YYYY
}
router.get('/:studentId/available-makeup-sessions/:absentSessionId', async (req, res) => {
    const { studentId, absentSessionId } = req.params;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Get the absent session details (same as before)
        const absentSessionQuery = `
            SELECT 
                a.id AS attendance_id,
                so."date" AS absent_date,
                s."Module_id" AS module_id,
                s."type" AS session_type,
                s.id AS session_id, 
                m.promotion_id,
                s.group_id,
                m."name" AS module_name,
                (SELECT MIN(so2."date") 
                 FROM public.sessionoccurrence so2
                 JOIN public."session" s2 ON so2.session_id = s2.id
                 WHERE s2."Module_id" = s."Module_id"
                 AND so2."date" > so."date") AS next_session_date
            FROM public."Attendance" a
            JOIN public.sessionoccurrence so ON a.sessionoccur_id = so.id
            JOIN public."session" s ON so.session_id = s.id
            JOIN public."Module" m ON s."Module_id" = m.id
            WHERE a.id = $1 AND a.student_id = $2 AND a.present = false
        `;
        
        const absentSessionResult = await client.query(absentSessionQuery, [absentSessionId, studentId]);
        
        if (absentSessionResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'Absent session not found' });
        }

        const absentSession = absentSessionResult.rows[0];

        const {
            attendance_id,
            absent_date,
            module_id,
            session_type,
            promotion_id,
            group_id,
            module_name,
            next_session_date,
            session_id
        } = absentSession;

        // 2. Check for existing compensation request (same as before)
        const checkCompensatedQuery = `
              SELECT 
                (SELECT 1 FROM public."Student_MakeupSession" WHERE att_id = $1 LIMIT 1) AS has_makeup,
                (SELECT 1 FROM public."CompensationRequest" WHERE attendence_id = $1 LIMIT 1) AS has_compensation
        `;

       
        
        const compensatedResult = await client.query(checkCompensatedQuery, [absentSessionId]);

        // In the /available-makeup-sessions/:absentSessionId route
if (compensatedResult.rows[0].has_makeup) {
    await client.query('ROLLBACK');
    return res.status(400).json({
        success: false,
        message: 'Makeup session already exists for this absence',
        errorType: 'makeup_exists'
    });
}
else if (compensatedResult.rows[0].has_compensation) {
    await client.query('ROLLBACK');
    return res.status(400).json({
        success: false,
        message: 'Compensation request already exists for this absence',
        errorType: 'compensation_exists'
    });
}

        // 3. Retrieve the student's busy sessions
        const studentBusySessionsQuery = `
            WITH student_busy_times AS (
                SELECT so."date", dt."day", dt."startTime", dt."endTime", s."type"
                FROM public."Student" st
                JOIN public."Group" g ON st.group_id = g.id
                JOIN public."session" s ON g.id = s.group_id
                JOIN public.sessionoccurrence so ON s.id = so.session_id
                JOIN public."dayTime" dt ON s.time_id = dt.id
                WHERE st.matricule = $1
                AND so.profabsence = false
                AND so."date" >= $2::date
                ${absentSession.next_session_date ? `AND so."date" <= $3::date` : ''}

                UNION ALL

                SELECT so."date", cdt."day", cdt."startTime", cdt."endTime", s."type"
                FROM public."Student" st
                JOIN public."Group" g ON st.group_id = g.id
                JOIN public."session" s ON g.id = s.group_id
                JOIN public.sessionoccurrence so ON s.id = so.session_id
                JOIN public."dayTime" cdt ON so.comdaytimid = cdt.id
                WHERE st.matricule = $1
                AND so.profabsence = true
                AND so.is_compensation = true
                AND so."date" >= $2::date
                ${absentSession.next_session_date ? `AND so."date" <= $3::date` : ''}

                UNION ALL

                SELECT so."date", dt."day", dt."startTime", dt."endTime", s."type"
                FROM public."Student_MakeupSession" sms
                JOIN public.sessionoccurrence so ON sms.sessionoccur_id = so.id
                JOIN public."session" s ON so.session_id = s.id
                JOIN public."dayTime" dt ON s.time_id = dt.id
                WHERE sms."Student_id" = $1
                AND so."date" >= $2::date
                ${absentSession.next_session_date ? `AND so."date" <= $3::date` : ''}

                UNION ALL

                SELECT so."date", dt."day", dt."startTime", dt."endTime", s."type"
                FROM public."Student_DebtSessions" sds
                JOIN public."session" s ON sds.session_id = s.id
                JOIN public.sessionoccurrence so ON so.session_id = s.id
                JOIN public."dayTime" dt ON s.time_id = dt.id
                WHERE sds.student_id = $1
                AND so."date" >= $2::date
                ${absentSession.next_session_date ? `AND so."date" <= $3::date` : ''}
            )
            SELECT * FROM student_busy_times
        `;
        
        const busyParams = [studentId, absentSession.absent_date];
        if (absentSession.next_session_date) busyParams.push(absentSession.next_session_date);
        const busySessions = await client.query(studentBusySessionsQuery, busyParams);

        // 4. Get available makeup sessions with progress information
        const availableParams = [];
        availableParams.push(absentSession.module_id);      // $1
        availableParams.push(absentSession.promotion_id);   // $2
        availableParams.push(absentSession.group_id);       // $3
        availableParams.push(absentSession.absent_date);    // $4

        if (absentSession.next_session_date) {
            availableParams.push(absentSession.next_session_date); // $5
        }

        const studentIdIndex = availableParams.length + 1;
        availableParams.push(studentId); // $6 or $7

        const busyStartIndex = availableParams.length + 1;
        busySessions.rows.forEach(session => {
            availableParams.push(session.date);
            availableParams.push(session.day);
            availableParams.push(session.startTime[0]);
            availableParams.push(session.endTime[0]);
        });
        const busyPlaceholders = busySessions.rows.map((_, i) => {
            const offset = busyStartIndex + i * 4;
            return `($${offset}, $${offset + 1}, $${offset + 2}, $${offset + 3})`;
        }).join(', ');
        

        const availableSessionsQuery = `
            WITH session_capacity AS (
                SELECT 
                    s.id AS session_id,
                    r.capacity,
                    COUNT(DISTINCT gs.matricule) AS enrolled,
                    COUNT(DISTINCT sms."Student_id") AS makeup,
                    COUNT(DISTINCT sds.student_id) AS debt,
                    r.capacity - COUNT(DISTINCT gs.matricule) 
                             - COUNT(DISTINCT sms."Student_id") 
                             - COUNT(DISTINCT sds.student_id) AS available
                FROM public."session" s
                JOIN public."Room" r ON s.room_id = r.id
                JOIN public."Group" g ON s.group_id = g.id
                JOIN public."Student" gs ON g.id = gs.group_id
                LEFT JOIN public."Student_MakeupSession" sms ON sms.sessionoccur_id IN (
                    SELECT id FROM public.sessionoccurrence WHERE session_id = s.id
                )
                LEFT JOIN public."Student_DebtSessions" sds ON sds.session_id = s.id
                WHERE s."Module_id" = $1
                GROUP BY s.id, r.capacity
            ),
            module_progress AS (
                SELECT 
                    m.id AS module_id,
                    COUNT(CASE WHEN a.present = true THEN 1 END) AS attended_sessions,
                    COUNT(a.id) AS total_sessions,
                    CASE 
                        WHEN COUNT(a.id) > 0 THEN 
                            ROUND(COUNT(CASE WHEN a.present = true THEN 1 END) * 100.0 / COUNT(a.id))
                        ELSE 0 
                    END AS progress_percentage
                FROM public."Module" m
                JOIN public."session" s ON m.id = s."Module_id"
                JOIN public.sessionoccurrence so ON s.id = so.session_id
                JOIN public."Attendance" a ON so.id = a.sessionoccur_id
                WHERE a.student_id = $6
                GROUP BY m.id
            ),
     
  title_progress AS (
    SELECT 
          s."Module_id" AS module_id,
        s.id AS session_id,
        COUNT(t.id) AS total_titles,
        SUM(CASE WHEN p.is_completed THEN 1 ELSE 0 END) AS completed_titles,
        CASE 
            WHEN COUNT(t.id) > 0 THEN 
                ROUND((SUM(CASE WHEN p.is_completed THEN 1 ELSE 0 END) * 100.0) / COUNT(t.id))
            ELSE 0 
        END AS title_progress_percentage
    FROM public."session" s
    JOIN public."ModuleTitle " t ON t.module_id = s."Module_id" AND t."type" = s."type"
    LEFT JOIN public."ProfessorTitleProgress" p ON p.title_id = t.id AND p.session_id = s.id
    WHERE s."Module_id" = $1
    GROUP BY s.id
)
            SELECT 
                s.id,
                s."Module_id",
                m."name" AS module_name,
                so.id AS occurrence_id,
                so."date",
                dt."day",
                dt."startTime",
                dt."endTime",
                sc.available,
                s."type",
                mp.progress_percentage AS module_progress,
               COALESCE(tp.title_progress_percentage, 0) AS title_progress,
               COALESCE(tp.completed_titles, 0) AS completed_titles,
               COALESCE(tp.total_titles, 0) AS total_titles,
               CONCAT(prof.firstname, ' ', prof.lastname) AS professor_name
            FROM public."session" s
            JOIN public."Module" m ON s."Module_id" = m.id
            JOIN public.sessionoccurrence so ON s.id = so.session_id
            JOIN public."dayTime" dt ON s.time_id = dt.id
            JOIN session_capacity sc ON s.id = sc.session_id
            JOIN module_progress mp ON m.id = mp.module_id
            LEFT JOIN title_progress tp ON m.id = tp.module_id AND  tp.session_id = s.id
            JOIN public."Professor" prof ON s.prof_id = prof.matricule 
            WHERE s."type" IN ('dw', 'pw')
            AND s."Module_id" = $1
            AND m.promotion_id = $2
            AND s.group_id != $3
            AND so."date" >= $4::date
            ${absentSession.next_session_date ? `AND so."date" <= $5::date` : ''}
            AND sc.available > 0
            AND NOT EXISTS (
                SELECT 1 FROM public.sessionoccurrence 
                WHERE session_id = s.id AND profabsence = true AND is_compensation = false
            )
            ${busySessions.rows.length > 0 ? `AND NOT EXISTS (
    SELECT 1 FROM (VALUES ${busyPlaceholders}) AS bt("date", "day", "startTime", "endTime")
    WHERE so."date" = bt."date"::date
    AND dt."day" = bt."day"
    AND (
       (dt."startTime"[1] < bt."endTime"::time AND dt."endTime"[1] > bt."startTime"::time)

    )
)
` : ''} 
            ORDER BY so."date", dt."startTime"
        `;

       
  // 2. Get title progress with parameterized query
const absentTitleProgressQuery = `
SELECT 
    COUNT(*) AS total_titles,
    SUM(CASE WHEN p.is_completed THEN 1 ELSE 0 END) AS completed_titles,
    CASE 
        WHEN COUNT(*) > 0 THEN 
            ROUND((SUM(CASE WHEN p.is_completed THEN 1 ELSE 0 END) * 100.0) / COUNT(*))
        ELSE 0 
    END AS title_progress_percentage
FROM public."ModuleTitle " t
LEFT JOIN public."ProfessorTitleProgress" p 
    ON p.title_id = t.id AND p.session_id = $1
WHERE t.module_id = $2 AND t."type" = $3
`;


    
    const absentTitleProgressResult = await client.query(absentTitleProgressQuery, [
        session_id, 
        module_id, 
        session_type
    ]);
    
    const absentTitleProgress = absentTitleProgressResult.rows[0];
    
      
        const availableSessions = await client.query(availableSessionsQuery, availableParams);
        await client.query('COMMIT');

 // After getting both absentTitleProgress and availableSessions
const filteredSessions = availableSessions.rows.filter(session => {
    return absentTitleProgress.completed_titles >= session.completed_titles;
});

// Format results with progress information
const result = filteredSessions.map(session => ({
    session_id: session.id,
    occurrence_id: session.occurrence_id,
    module: session.module_name,
    date: formatDate(session.date),
    day: session.day,
    time: `${formatTime(session.startTime)} - ${formatTime(session.endTime)}`,
    available_slots: session.available,
    session_type: session.type,
    professor: session.professor_name,
    progress: {
        title_progress: session.title_progress,
        completed_titles: session.completed_titles,
        total_titles: session.total_titles
                                                                         
    },
    is_allowed: absentTitleProgress.completed_titles >= session.completed_titles
}));


        res.json({ 
            success: true, 
            data: result,
            original_module: absentSession.module_name,
        absent_session_title_progress: {
    title_progress: absentTitleProgress.title_progress_percentage,
    completed_titles: absentTitleProgress.completed_titles,
    total_titles: absentTitleProgress.total_titles
}
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Database error',
            error: error.message 
        });
    } finally {
        client.release();
    }
});

// Helper to format the date in a readable format
function formatDate(date) {
    const formattedDate = new Date(date);
    return formattedDate.toLocaleDateString('en-US'); // Adjust format as necessary
}

// Helper to format time
function formatTime(timeArray) {
    return timeArray[0].substring(0, 5); // Format HH:MM
}




router.post('/select-session', async (req, res) => {
    const { studentId, attendanceId, sessionId } = req.body; // sessionId here is the occurrenceId
    console.log('Received request with sessionId (occurrenceId):', sessionId); 
    console.log('Received request with studentId:', studentId); 
    console.log('Received request with attendanceId:', attendanceId); 

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Verify the session exists and get its details (no need to fetch occurrence_id separately)
        const sessionQuery = `
            SELECT s."type", r.capacity, 
                   (SELECT COUNT(*) FROM public."Student_MakeupSession" WHERE sessionoccur_id = so.id) AS current_attendees
            FROM public."session" s
            JOIN public."Room" r ON s.room_id = r.id
            JOIN public.sessionoccurrence so ON s.id = so.session_id
            WHERE so.id = $1;  
        `;
        
        const sessionResult = await client.query(sessionQuery, [sessionId]);

        if (sessionResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'Session not found' });
        }

        const session = sessionResult.rows[0];
        const sessionType = session.type;
        const roomCapacity = session.capacity;
        const currentAttendees = session.current_attendees;

        // 2. Verify the attendance record exists and belongs to the student
        const attendanceQuery = `
            SELECT id FROM public."Attendance" 
            WHERE id = $1 AND student_id = $2 AND present = false;
        `;
        const attendanceResult = await client.query(attendanceQuery, [attendanceId, studentId]);
        
        if (attendanceResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ 
                success: false, 
                message: 'Attendance record not found or already marked as present' 
            });
        }

        // 3. Handle based on session type
        if (sessionType === 'dw') {
            // DW session - direct enrollment if space is available
            if (currentAttendees >= roomCapacity) {
                await client.query('ROLLBACK');
                return res.status(400).json({ 
                    success: false, 
                    message: 'No available slots in this session' 
                });
            }

            // Check if the student is already enrolled in this session
            const checkEnrollmentQuery = `
                SELECT 1 FROM public."Student_MakeupSession" 
                WHERE "Student_id" = $1 AND sessionoccur_id = $2;
            `;
            const enrollmentResult = await client.query(checkEnrollmentQuery, [studentId, sessionId]); // sessionId is now occurrenceId
            
            if (enrollmentResult.rows.length > 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({ 
                    success: false, 
                    message: 'Student already enrolled in this makeup session' 
                });
            }

            // Enroll the student in the session
            const enrollQuery = `
                INSERT INTO public."Student_MakeupSession" 
                ("Student_id", sessionoccur_id, att_id)
                VALUES ($1, $2, $3);
            `;
            await client.query(enrollQuery, [studentId, sessionId, attendanceId]); // Use sessionId directly as occurrenceId

            await client.query('COMMIT');
            return res.json({ 
                success: true, 
                message: 'Successfully enrolled in makeup session' 
            });

        } else if (sessionType === 'pw') {
            // PW session - create a compensation request
            const requestId = uuidv4();

            // Create compensation request
            const requestQuery = `
                INSERT INTO public."CompensationRequest" 
                (request_id, session_id, status, attendence_id)
                VALUES ($1, $2, $3, $4);
            `;
            await client.query(requestQuery, [
                requestId, 
                sessionId,  // Use sessionId directly as occurrenceId
                'Awaiting response', 
                attendanceId
            ]);

            await client.query('COMMIT');
            return res.json({ 
                success: true, 
                message: 'Compensation request created successfully' 
            });

        } else {
            await client.query('ROLLBACK');
            return res.status(400).json({ 
                success: false, 
                message: 'Invalid session type for makeup' 
            });
        }

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error selecting makeup session:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Server error while processing makeup session selection' 
        });
    } finally {
        client.release();
    }
});


router.get('/:id/absence-percentage', async (req, res) => {
    const studentId = req.params.id;
    
    const query = `
      SELECT 
        ROUND(
          (SUM(CASE WHEN present = false THEN 1 ELSE 0 END) * 100.0 / 
          NULLIF(COUNT(*), 0)), 
        2) AS absence_percentage
      FROM "Attendance"
      WHERE student_id = $1
      GROUP BY student_id
    `;
    
    try {
      const result = await pool.query(query, [studentId]);
      // Convert the string to number using parseFloat before sending
      const percentage = result.rows[0] ? parseFloat(result.rows[0].absence_percentage) : 0;
      res.json({ absencePercentage: percentage });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
});

module.exports = router;

