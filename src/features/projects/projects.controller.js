const { Op, fn, col, literal, QueryTypes } = require('sequelize');
const { sequelize, Project, Telemetry } = require('../../config/db');

async function getProjects(req, res) {
    if (req.user.role !== 'developer')
        return res.status(403).json({ error: 'Only developers have projects' });

    // Auto-ship projects with no activity in 30 days
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await Project.update(
        { status: 'shipped' },
        {
            where: {
                user_id: req.user.id,
                status:  'in_progress',
                last_seen: { [Op.lte]: thirtyDaysAgo },
            },
        }
    );

    const projects = await sequelize.query(`
        SELECT
            p.*,
            COALESCE(SUM(t.active_seconds), 0)  AS total_seconds,
            COALESCE(SUM(t.lines_added), 0)      AS lines_added,
            COALESCE(SUM(t.lines_deleted), 0)    AS lines_deleted,
            COALESCE(SUM(t.lines_modified), 0)   AS lines_modified
        FROM projects p
        LEFT JOIN telemetry t ON p.user_id = t.user_id AND p.name = t.project_name
        WHERE p.user_id = :userId
        GROUP BY p.id
        ORDER BY p.last_seen DESC NULLS LAST
    `, {
        replacements: { userId: req.user.id },
        type: QueryTypes.SELECT,
    });

    return res.json({ projects });
}

async function addProject(req, res) {
    if (req.user.role !== 'developer')
        return res.status(403).json({ error: 'Only developers can add projects' });

    const { name, description, framework, status = 'planned' } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const existing = await Project.findOne({
        where: { user_id: req.user.id, name },
    });
    if (existing) return res.status(409).json({ error: 'Project already exists' });

    const project = await Project.create({
        user_id:     req.user.id,
        name,
        description: description || null,
        framework:   framework   || 'none',
        status,
        is_manual:   true,
    });

    return res.status(201).json({ project: project.toJSON() });
}

async function updateProject(req, res) {
    if (req.user.role !== 'developer')
        return res.status(403).json({ error: 'Only developers can update projects' });

    const project = await Project.findOne({
        where: { id: req.params.id, user_id: req.user.id },
    });
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const allowed = ['name', 'description', 'framework', 'status'];
    const updates = {};
    for (const key of allowed) {
        if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    if (Object.keys(updates).length === 0)
        return res.status(400).json({ error: 'No valid fields to update' });

    await project.update(updates);
    return res.json({ project: project.toJSON() });
}

async function deleteProject(req, res) {
    if (req.user.role !== 'developer')
        return res.status(403).json({ error: 'Only developers can delete projects' });

    const project = await Project.findOne({
        where: { id: req.params.id, user_id: req.user.id },
    });
    if (!project) return res.status(404).json({ error: 'Project not found' });

    if (!project.is_manual)
        return res.status(400).json({ error: 'Auto-detected projects cannot be deleted. Mark as shipped instead.' });

    await project.destroy();
    return res.json({ message: 'Project deleted' });
}

module.exports = { getProjects, addProject, updateProject, deleteProject };