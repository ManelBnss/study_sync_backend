const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db');
require('dotenv').config();

// ... (previous imports remain the same)

/**
 * @route GET /api/professors/:professorId/sessions
 * @description Get all sessions for a professor with progress
*/

router.get('/:professorId/sessions', async (req, res) => {
    try {
        const { professorId } = req.params;
        
        const sessionsQuery = `
            SELECT 
                s.id AS session_id,
                s."Module_id",
                s.type,
                s.group_id,
                m."name" AS module_name,
                g."name" AS group_name,
                dt.day,
                dt."startTime",
                dt."endTime",
                l.level AS level_name,
                sec."name" AS section_name
            FROM public."session" s
            JOIN public."Module" m ON s."Module_id" = m.id
            JOIN public."dayTime" dt ON s.time_id = dt.id
            LEFT JOIN public."Group" g ON s.group_id = g.id
            JOIN public."Promotion" p ON m.promotion_id = p.id
            LEFT JOIN public."section" sec ON s.section_id = sec.id
            LEFT JOIN public."level" l ON p.level_id = l.level
            WHERE s.prof_id = $1
            ORDER BY dt."startTime" DESC;
        `;
        
        const { rows: sessions } = await pool.query(sessionsQuery, [professorId]);

        const sessionsWithProgress = await Promise.all(
            sessions.map(async session => {
                // Use session.id instead of undefined sessionId
                const totalQuery = `
                    SELECT COUNT(*) 
                    FROM public."ModuleTitle " 
                    WHERE module_id = $1 AND "type" = $2
                `;
                const totalRes = await pool.query(totalQuery, [session.Module_id, session.type]);
                
                const completedQuery = `
                    SELECT COUNT(DISTINCT ptp.title_id)
                    FROM public."ProfessorTitleProgress" ptp
                    JOIN public."ModuleTitle " t ON ptp.title_id = t.id
                    WHERE ptp.session_id = $1
                    AND t.module_id = $2
                    AND t."type" = $3
                    AND ptp.is_completed = true
                `;
                const completedRes = await pool.query(completedQuery, 
                    [session.session_id, session.Module_id, session.type]);
                
                return {
                    ...session,
                    progress: {
                        completed: parseInt(completedRes.rows[0]?.count || 0),
                        total: parseInt(totalRes.rows[0]?.count || 0),
                        percentage: totalRes.rows[0]?.count > 0 
                            ? Math.round((parseInt(completedRes.rows[0]?.count || 0) / parseInt(totalRes.rows[0]?.count)) * 100)
                            : 0
                    }
                };
            })
        );
        
        res.json({ success: true, data: sessionsWithProgress });
    } catch (error) {
        console.error('Error fetching sessions:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// Get titles for a specific SESSION (not module/type)
router.get('/sessions/:sessionId/titles', async (req, res) => {
    try {
        const { sessionId } = req.params;
        
        // Get session info and verify professor access
        const sessionQuery = `
            SELECT s.id, s."Module_id", s.type, s.prof_id,
                   m.name as module_name, 
                   p.firstname || ' ' || p.lastname as professor_name
            FROM public."session" s
            JOIN public."Module" m ON s."Module_id" = m.id
            JOIN public."Professor" p ON s.prof_id = p.matricule
            WHERE s.id = $1
        `;
        const { rows: sessionRows } = await pool.query(sessionQuery, [sessionId]);
        
        if (sessionRows.length === 0) {
            return res.status(404).json({ success: false, message: 'Session not found' });
        }

        const session = sessionRows[0];
        const moduleId = session.Module_id;
        const sessionType = session.type;

        // Get titles for THIS SESSION
        const titlesQuery = `
            WITH RECURSIVE title_hierarchy AS (
                SELECT id, module_id, title_name, "type", parent_id, "order", 0 AS level
                FROM public."ModuleTitle "
                WHERE parent_id IS NULL AND module_id = $1 AND "type" = $2
                UNION ALL
                SELECT t.id, t.module_id, t.title_name, t."type", t.parent_id, t."order", h.level + 1
                FROM public."ModuleTitle " t
                JOIN title_hierarchy h ON t.parent_id = h.id
            )
            SELECT 
                h.id, h.module_id, h.title_name, h."type", 
                h.parent_id, h."order", h.level,
                p.id AS progress_id, p.is_completed
            FROM title_hierarchy h
            LEFT JOIN public."ProfessorTitleProgress" p 
                ON p.title_id = h.id AND p.session_id = $3
            ORDER BY h.level, h."order"
        `;
        
        const { rows: titles } = await pool.query(titlesQuery, [moduleId, sessionType, sessionId]);

        // Progress for THIS SESSION
        const progressQuery = `
            SELECT 
                COUNT(*) AS total_titles,
                SUM(CASE WHEN p.is_completed THEN 1 ELSE 0 END) AS completed_titles
            FROM public."ModuleTitle " t
            LEFT JOIN public."ProfessorTitleProgress" p 
                ON p.title_id = t.id AND p.session_id = $1
            WHERE t.module_id = $2 AND t."type" = $3
        `;
        
        const { rows: progress } = await pool.query(progressQuery, [sessionId, moduleId, sessionType]);
        
        res.json({
            success: true,
            data: {
                session: {
                    id: session.id,
                    module_id: moduleId,
                    module_name: session.module_name,
                    type: sessionType,
                    professor: session.professor_name
                },
                titles: organizeTitlesHierarchically(titles),
                progress: {
                    completed: parseInt(progress[0]?.completed_titles || 0),
                    total: parseInt(progress[0]?.total_titles || 0),
                    percentage: progress[0]?.total_titles > 0 
                        ? Math.round((progress[0].completed_titles / progress[0].total_titles) * 100)
                        : 0
                }
            }
        });
    } catch (error) {
        console.error('Error fetching session titles:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while fetching session titles',
            error: error.message
        });
    }
});
// ... (rest of the file remains the same)
/**
 * @route POST /api/professors/:professorId/title-progress
 * @description Update title progress
 */
router.post('/:professorId/title-progress', async (req, res) => {
    try {
        const { professorId } = req.params;
        const { titleId, isCompleted, sessionId } = req.body;

        // Verify the professor has access to this title's module
        const accessQuery = `
            SELECT 1 FROM public."ModuleTitle " t
            JOIN public."session" s ON t.module_id = s."Module_id"
            WHERE t.id = $1 AND s.prof_id = $2 AND s.id = $3
            LIMIT 1
        `;
        const { rowCount } = await pool.query(accessQuery, [titleId, professorId, sessionId]);
        
        if (rowCount === 0) {
            return res.status(403).json({
                success: false,
                message: 'You do not have access to this title'
            });
        }

        // Check if progress record exists
        const checkQuery = `
            SELECT id FROM public."ProfessorTitleProgress" 
            WHERE session_id = $1 AND title_id = $2
        `;
        const { rows: existing } = await pool.query(checkQuery, [sessionId, titleId]);

        let result;
        if (existing.length > 0) {
            // Update existing record
            const updateQuery = `
                UPDATE public."ProfessorTitleProgress"
                SET is_completed = $1
                WHERE id = $2
                RETURNING *
            `;
            result = await pool.query(updateQuery, [isCompleted, existing[0].id]);
        } else {
            // Create new record
            const insertQuery = `
                INSERT INTO public."ProfessorTitleProgress" 
                (id, title_id, is_completed, session_id)
                VALUES (gen_random_uuid(), $1, $2, $3)
                RETURNING *
            `;
            result = await pool.query(insertQuery, [titleId, isCompleted, sessionId]);
        }

        res.json({
            success: true,
            data: result.rows[0]
        });
    } catch (error) {
        console.error('Error updating title progress:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while updating title progress',
            error: error.message
        });
    }
});

/**
 * @route POST /api/professors/:professorId/title-progress/bulk
 * @description Update progress for multiple titles at once
 */
router.post('/:professorId/title-progress/bulk', async (req, res) => {
    try {
        const { professorId } = req.params;
        const { titleIds, isCompleted, sessionId } = req.body;

        if (!titleIds || !Array.isArray(titleIds) || !sessionId) {
            return res.status(400).json({
                success: false,
                message: 'Invalid request format. Expected sessionId and array of titleIds'
            });
        }

        // Verify the professor has access to this session
        const accessQuery = `
            SELECT 1 FROM public."session"
            WHERE id = $1 AND prof_id = $2
            LIMIT 1
        `;
        const { rowCount } = await pool.query(accessQuery, [sessionId, professorId]);
        
        if (rowCount === 0) {
            return res.status(403).json({
                success: false,
                message: 'You do not have access to this session'
            });
        }

        // Process updates in a transaction
        await pool.query('BEGIN');

        try {
            // Delete existing progress for these titles in this session
            await pool.query(`
                DELETE FROM public."ProfessorTitleProgress"
                WHERE session_id = $1 AND title_id = ANY($2)
            `, [sessionId, titleIds]);

            // Only insert if isCompleted is true
            if (isCompleted) {
                await pool.query(`
                    INSERT INTO public."ProfessorTitleProgress" 
                    (id, title_id, is_completed, session_id)
                    SELECT gen_random_uuid(), id, $1, $2
                    FROM unnest($3::uuid[]) AS id
                `, [isCompleted, sessionId, titleIds]);
            }

            await pool.query('COMMIT');
            
            res.json({
                success: true,
                message: 'Bulk update successful',
                updatedCount: titleIds.length
            });
        } catch (error) {
            await pool.query('ROLLBACK');
            throw error;
        }
    } catch (error) {
        console.error('Error in bulk progress update:', error);
        res.status(500).json({
            success: false,
            message: 'Server error during bulk update',
            error: error.message
        });
    }
});



// Helper function to organize titles hierarchically
function organizeTitlesHierarchically(titles) {
    const titleMap = {};
    const rootTitles = [];
    
    titles.forEach(title => {
        titleMap[title.id] = {
            ...title,
            children: []
        };
    });
    
    titles.forEach(title => {
        if (title.parent_id) {
            if (titleMap[title.parent_id]) {
                titleMap[title.parent_id].children.push(titleMap[title.id]);
            }
        } else {
            rootTitles.push(titleMap[title.id]);
        }
    });
    
    return rootTitles;
}

module.exports = router;