const express = require('express');
const router = express.Router();
const pool = require('../db');
const { v4: uuidv4 } = require('uuid');

// Get professor's modules
router.get('/getProfessorModules/:matricule', async (req, res) => {
  const { matricule } = req.params;

  try {
    // Main query with corrected column name
    const query = `
      SELECT 
        m.id AS module_id,
        m."name" AS module_name,
        p.id AS promotion_id,
        p.specialty_id,
        p.level_id,
        s."name" AS specialty_name,
        sem." SemesterID" AS semester_id,
        sem."StartDate" AS semester_start,
        sem."EndDate " AS semester_end
      FROM public."Module" m
      JOIN public."Promotion" p ON m.promotion_id = p.id
      JOIN public."Specialty" s ON p.specialty_id = s.code
      JOIN public."Semester" sem ON m.semester_id = sem." SemesterID"
      WHERE m.responsible_professor_id = $1
      ORDER BY sem."StartDate" DESC
    `;

    const { rows } = await pool.query(query, [matricule]);

    if (rows.length === 0) {
      // Verify professor exists first
      const professorCheck = await pool.query(
        'SELECT matricule FROM public."Professor" WHERE matricule = $1', 
        [matricule]
      );
      
      return res.status(200).json({
        success: true,
        message: 'Professor found but no modules assigned',
        professor: professorCheck.rows[0]
      });
    }

    res.status(200).json({
      success: true,
      count: rows.length,
      data: rows
    });

  } catch (error) {
    console.error('Database error:', error);
    res.status(500).json({
      success: false,
      error: 'Database query failed',
      details: error.message
    });
  }
});

// Get hierarchical title structure for a specific module and type
router.get('/getModuleTitles/:moduleId/:type', async (req, res) => {
  try {
    const { moduleId, type } = req.params;
    
    // Validate type
    const validTypes = ['pw', 'dw', 'cours'];
    if (!validTypes.includes(type)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid type. Must be one of: pw, dw, cours'
      });
    }

    // First get all titles for this module and type
    const { rows: flatTitles } = await pool.query(
      `SELECT id, title_name, type, parent_id, "order"
       FROM public."ModuleTitle "
       WHERE module_id = $1 AND type = $2
       ORDER BY "order" ASC`,
      [moduleId, type]
    );

    // Convert flat list to hierarchical structure
    const buildHierarchy = (parentId = null) => {
      return flatTitles
        .filter(title => 
          (parentId === null && title.parent_id === null) || 
          title.parent_id === parentId
        )
        .sort((a, b) => a.order - b.order)
        .map(title => ({
          id: title.id,
          title_name: title.title_name,
          type: title.type,
          order: title.order,
          children: buildHierarchy(title.id)
        }));
    };

    const hierarchicalTitles = buildHierarchy();

    res.status(200).json({
      success: true,
      data: hierarchicalTitles
    });
  } catch (error) {
    console.error('Database error:', error);
    res.status(500).json({
      success: false,
      error: 'Database query failed',
      details: error.message
    });
  }
});

// Create a new title with specific type
router.post('/createModuleTitle', async (req, res) => {
  const { module_id, title_name, type, parent_id } = req.body;

  // Validate required fields
  if (!module_id || !title_name || !type) {
    return res.status(400).json({
      success: false,
      error: 'module_id, title_name, and type are required'
    });
  }

  // Validate type
  const validTypes = ['pw', 'dw', 'cours'];
  if (!validTypes.includes(type)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid type. Must be one of: pw, dw, cours'
    });
  }

  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Verify module exists and professor has access
      const moduleCheck = await client.query(
        `SELECT responsible_professor_id FROM public."Module" WHERE id = $1`,
        [module_id]
      );
      
      if (moduleCheck.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: 'Module not found'
        });
      }

      // Get the next order value for this level and type
      const orderResult = await client.query(
        `SELECT COALESCE(MAX("order"), -1) + 1 as next_order 
         FROM public."ModuleTitle " 
         WHERE module_id = $1 AND type = $2 AND parent_id ${parent_id ? '= $3' : 'IS NULL'}`,
        parent_id ? [module_id, type, parent_id] : [module_id, type]
      );
      const nextOrder = orderResult.rows[0].next_order;

      // Create new title
      const id = uuidv4();
      const { rows } = await client.query(
        `INSERT INTO public."ModuleTitle " (
          id, module_id, title_name, type, parent_id, "order"
        ) VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *`,
        [id, module_id, title_name, type, parent_id || null, nextOrder]
      );

      await client.query('COMMIT');
      res.status(201).json({
        success: true,
        data: rows[0]
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Database error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create module title',
      details: error.message
    });
  }
});

// Update title (rename, change type, or move in hierarchy)
router.put('/updateModuleTitle/:id', async (req, res) => {
  const { id } = req.params;
  const { title_name, type, parent_id, order } = req.body;

  if (!title_name && !type && parent_id === undefined && order === undefined) {
    return res.status(400).json({
      success: false,
      error: 'At least one field to update is required'
    });
  }

  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Get current title info
      const { rows: [currentTitle] } = await client.query(
        `SELECT module_id, type FROM public."ModuleTitle " WHERE id = $1`,
        [id]
      );

      if (!currentTitle) {
        return res.status(404).json({
          success: false,
          error: 'Title not found'
        });
      }

      // Validate type if provided
      if (type) {
        const validTypes = ['pw', 'dw', 'cours'];
        if (!validTypes.includes(type)) {
          return res.status(400).json({
            success: false,
            error: 'Invalid type. Must be one of: pw, dw, cours'
          });
        }
      }

      // If changing parent or order, we need to reorder siblings
      if (parent_id !== undefined || order !== undefined) {
        const newParent = parent_id !== undefined ? parent_id : currentTitle.parent_id;
        const newOrder = order !== undefined ? order : (
          await client.query(
            `SELECT COALESCE(MAX("order"), -1) + 1 as next_order 
             FROM public."ModuleTitle " 
             WHERE module_id = $1 AND type = $2 AND parent_id ${newParent ? '= $3' : 'IS NULL'}`,
            newParent ? [currentTitle.module_id, currentTitle.type, newParent] : [currentTitle.module_id, currentTitle.type]
          )
        ).rows[0].next_order;

        await client.query(
          `UPDATE public."ModuleTitle "
           SET title_name = COALESCE($1, title_name),
               type = COALESCE($2, type),
               parent_id = $3,
               "order" = $4
           WHERE id = $5`,
          [title_name, type, newParent, newOrder, id]
        );
      } else {
        // Simple update (just title_name or type)
        await client.query(
          `UPDATE public."ModuleTitle "
           SET title_name = COALESCE($1, title_name),
               type = COALESCE($2, type)
           WHERE id = $3`,
          [title_name, type, id]
        );
      }

      const { rows: [updatedTitle] } = await client.query(
        `SELECT * FROM public."ModuleTitle " WHERE id = $1`,
        [id]
      );

      await client.query('COMMIT');
      res.status(200).json({
        success: true,
        data: updatedTitle
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Database error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update module title',
      details: error.message
    });
  }
});

// Delete a title and its children
router.delete('/deleteModuleTitle/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // First check if title exists
      const { rows: [title] } = await client.query(
        `SELECT module_id FROM public."ModuleTitle " WHERE id = $1`,
        [id]
      );

      if (!title) {
        return res.status(404).json({
          success: false,
          error: 'Title not found'
        });
      }

      // Recursively delete all children
      const deleteChildren = async (parentId) => {
        const { rows: children } = await client.query(
          `SELECT id FROM public."ModuleTitle " WHERE parent_id = $1`,
          [parentId]
        );

        for (const child of children) {
          await deleteChildren(child.id);
        }

        await client.query(
          `DELETE FROM public."ProfessorTitleProgress" WHERE title_id = $1`,
          [parentId]
        );

        await client.query(
          `DELETE FROM public."ModuleTitle " WHERE id = $1`,
          [parentId]
        );
      };

      await deleteChildren(id);

      await client.query('COMMIT');
      res.status(200).json({
        success: true,
        message: 'Title and its children deleted successfully'
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Database error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete module title',
      details: error.message
    });
  }
});

// Update the saveModuleTitlesStructure endpoint
router.post('/saveModuleTitlesStructure/:moduleId/:type', async (req, res) => {
  const { moduleId, type } = req.params;
  const { titles } = req.body;  // Changed from 'structure' to 'titles'

  try {
      const client = await pool.connect();
      try {
          await client.query('BEGIN');

          // ... existing validation code ...

          // Process the structure recursively - renamed from 'structure' to 'titles'
          const processStructure = async (items, parentId = null) => {
              for (const [index, item] of items.entries()) {
                  if (item.id && !item.id.startsWith('temp-')) {
                      // Update existing item
                      await client.query(
                          `UPDATE public."ModuleTitle "
                           SET "order" = $1, parent_id = $2, title_name = $3
                           WHERE id = $4 AND module_id = $5 AND type = $6`,
                          [index, parentId, item.title_name, item.id, moduleId, type]
                      );
                  } else {
                      // Create new item
                      const newId = uuidv4();
                      await client.query(
                          `INSERT INTO public."ModuleTitle "
                           (id, module_id, title_name, type, parent_id, "order")
                           VALUES ($1, $2, $3, $4, $5, $6)`,
                          [newId, moduleId, item.title_name, type, parentId, index]
                      );
                      item.id = newId;
                  }

                  if (item.children && item.children.length > 0) {
                      await processStructure(item.children, item.id);
                  }
              }
          };

          await processStructure(titles);  // Changed from 'structure' to 'titles'

          await client.query('COMMIT');
          res.status(200).json({
              success: true,
              message: 'Title structure saved successfully',
              data: titles  // Send back the updated structure
          });
      } catch (error) {
          await client.query('ROLLBACK');
          throw error;
      } finally {
          client.release();
      }
  } catch (error) {
      console.error('Database error:', error);
      res.status(500).json({
          success: false,
          error: 'Failed to save title structure',
          details: error.message
      });
  }
});

module.exports = router;