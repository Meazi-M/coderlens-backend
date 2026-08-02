const db = require('../../config/db');

function getProjects(req, res) {
    if (req.user.role !== 'developer')
        return res.status(403).json({ error: 'Only developers have projects' });

    // Auto-ship stale projects
    db.prepare(`
        UPDATE projects SET status = 'shipped'
        WHERE user_id = ? AND status = 'in_progress'
          AND last_seen <= datetime('now', '-30 days')
    `).run(req.user.id);

    const projects = db.prepare(`
        SELECT 
            p.*,
            COALESCE(SUM(t.active_seconds), 0) AS total_seconds,
            COALESCE(SUM(t.lines_added), 0) AS lines_added,
            COALESCE(SUM(t.lines_deleted), 0) AS lines_deleted,
            COALESCE(SUM(t.lines_modified), 0) AS lines_modified
        FROM projects p
        LEFT JOIN telemetry t ON p.user_id = t.user_id AND p.name = t.project_name
        WHERE p.user_id = ?
        GROUP BY p.id
        ORDER BY p.last_seen DESC
    `).all(req.user.id);

    return res.json({ projects });
}

function addProject(req, res) {
    if (req.user.role !== 'developer')
        return res.status(403).json({ error: 'Only developers can add projects' });

    const { name, description, framework, status = 'planned' } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const existing = db.prepare(
        'SELECT id FROM projects WHERE user_id = ? AND name = ?'
    ).get(req.user.id, name);
    if (existing) return res.status(409).json({ error: 'Project already exists' });

    const result = db.prepare(`
        INSERT INTO projects (user_id, name, description, framework, status, is_manual)
        VALUES (?, ?, ?, ?, ?, 1)
    `).run(req.user.id, name, description || null, framework || 'none', status);

    return res.status(201).json({
        project: db.prepare('SELECT * FROM projects WHERE id = ?').get(result.lastInsertRowid)
    });
}

function updateProject(req, res) {
    if (req.user.role !== 'developer')
        return res.status(403).json({ error: 'Only developers can update projects' });

    const project = db.prepare(
        'SELECT * FROM projects WHERE id = ? AND user_id = ?'
    ).get(req.params.id, req.user.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const allowed = ['name', 'description', 'framework', 'status'];
    const updates = {};
    for (const key of allowed) {
        if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    if (Object.keys(updates).length === 0)
        return res.status(400).json({ error: 'No valid fields to update' });

    const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    db.prepare(`UPDATE projects SET ${setClauses} WHERE id = ?`)
        .run(...Object.values(updates), project.id);

    return res.json({ project: db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id) });
}

function deleteProject(req, res) {
    if (req.user.role !== 'developer')
        return res.status(403).json({ error: 'Only developers can delete projects' });

    const project = db.prepare(
        'SELECT * FROM projects WHERE id = ? AND user_id = ?'
    ).get(req.params.id, req.user.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    if (!project.is_manual)
        return res.status(400).json({ error: 'Auto-detected projects cannot be deleted. Mark as shipped instead.' });

    db.prepare('DELETE FROM projects WHERE id = ?').run(project.id);
    return res.json({ message: 'Project deleted' });
}

module.exports = { getProjects, addProject, updateProject, deleteProject };