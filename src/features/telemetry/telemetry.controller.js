const { Op, fn, col, literal, QueryTypes } = require('sequelize');
const { sequelize, User, Telemetry, Project, Commit } = require('../../config/db');
const { notifyTelemetryUpdate } = require('../../websocket/wsServer');

// ── helpers ──────────────────────────────────────────────────────────────────

async function ensureTelemetryUser() {
    const email = 'telemetry@coderlens.local';
    let user = await User.findOne({ where: { email } });
    if (!user) {
        user = await User.create({ name: 'Telemetry User', email, password: null, role: 'developer' });
    }
    return user.id;
}

async function ensureUserExists(userId) {
    const user = await User.findByPk(userId);
    if (user) return userId;
    return ensureTelemetryUser();
}

function resolveUserId(req, payload) {
    if (req.user && req.user.id) return req.user.id;
    const bodyUserId = Number(payload?.userId || payload?.user_id || req.query?.userId);
    if (Number.isInteger(bodyUserId) && bodyUserId > 0) return bodyUserId;
    return null; // will be resolved to telemetry user async
}

function resolveProjectName(rec) {
    if (rec.projectName) return rec.projectName;
    if (rec.gitRepo && rec.gitRepo !== 'local') {
        return rec.gitRepo.split('/').pop().replace(/\.git$/, '');
    }
    const filePath = typeof rec.filePath === 'string' ? rec.filePath : '';
    const parts = filePath.split(/[/\\]/).filter(Boolean);
    return parts[0] || 'local-project';
}

// ── controllers ───────────────────────────────────────────────────────────────

async function ingestActivity(req, res) {
    console.log('📩 Telemetry request received');
    try {
        const payload = req.body || {};
        let userId = resolveUserId(req, payload);
        if (!userId) userId = await ensureTelemetryUser();
        else userId = await ensureUserExists(userId);

        const events = Array.isArray(payload.events) ? payload.events : [];
        if (events.length === 0)
            return res.status(200).json({ status: 'ok', inserted: 0 });

        const batchTimestamp = payload.timestamp ? new Date(payload.timestamp) : new Date();

        await User.update({ last_seen: new Date() }, { where: { id: userId } });

        // Process events in a transaction
        await sequelize.transaction(async (t) => {
            for (const rec of events) {
                const projectName = resolveProjectName(rec);
                const hasRemote   = !!(rec.gitRepo && rec.gitRepo !== 'local');

                // Handle committed events — update uncommitted telemetry & projects
                if (rec.lastCommitStatus === 'committed') {
                    await Telemetry.update(
                        {
                            last_commit_status:    'committed',
                            last_commit_hash:      rec.lastCommitHash || 'none',
                            last_commit_message:   rec.lastCommitMessage || '',
                            last_commit_timestamp: rec.lastCommitTimestamp || '',
                        },
                        {
                            where: {
                                user_id:           userId,
                                project_name:      projectName,
                                last_commit_status: 'uncommitted',
                                ...(hasRemote ? { git_repo: rec.gitRepo } : {}),
                            },
                            transaction: t,
                        }
                    );

                    await Project.update(
                        {
                            last_commit_status:    'committed',
                            last_commit_hash:      rec.lastCommitHash || 'none',
                            last_commit_message:   rec.lastCommitMessage || '',
                            last_commit_timestamp: rec.lastCommitTimestamp || '',
                        },
                        {
                            where: {
                                user_id:            userId,
                                last_commit_status: 'uncommitted',
                                [Op.or]: [
                                    { repo_name: projectName },
                                    { name:      projectName },
                                ],
                            },
                            transaction: t,
                        }
                    );

                    if (
                        rec.lastCommitHash &&
                        !['none', 'uncommitted', 'unknown'].includes(rec.lastCommitHash)
                    ) {
                        try {
                            await Commit.findOrCreate({
                                where: {
                                    user_id:      userId,
                                    project_name: projectName,
                                    commit_hash:  rec.lastCommitHash,
                                },
                                defaults: {
                                    git_branch:    rec.gitBranch || 'main',
                                    git_repo:      rec.gitRepo   || 'local',
                                    commit_message: rec.lastCommitMessage || '',
                                    committed_at:  rec.lastCommitTimestamp
                                        ? new Date(rec.lastCommitTimestamp)
                                        : batchTimestamp,
                                },
                                transaction: t,
                            });
                        } catch (_) {}
                    }
                }

                const activeSecs    = Number(rec.activeSeconds   ?? rec.active_seconds)   || 0;
                const linesAdded    = Number(rec.linesAdded      ?? rec.lines_added)       || 0;
                const linesDeleted  = Number(rec.linesDeleted    ?? rec.lines_deleted)     || 0;
                const linesModified = Number(rec.linesModified   ?? rec.lines_modified)    || 0;

                // Skip zero-second heartbeats (privacy + storage optimization)
                if (activeSecs === 0) continue;

                // Sanitize raw code changes — strip typed content for privacy
                const rawChanges = Array.isArray(rec.rawCodeChanges) ? rec.rawCodeChanges : [];
                const sanitizedChanges = rawChanges.map(change => ({
                    timeStamp: change.timeStamp || Date.now(),
                    type:      change.type || 'modify',
                    line:      change.line || 1,
                    amount:    change.amount || 0,
                }));

                await Telemetry.create(
                    {
                        user_id:               userId,
                        file_path:             rec.filePath  || '',
                        file_name:             rec.fileName  || '',
                        language_id:           rec.languageId           || 'unknown',
                        project_name:          projectName,
                        project_framework:     rec.projectFramework     || 'none',
                        git_branch:            rec.gitBranch            || 'none',
                        git_repo:              rec.gitRepo              || 'local',
                        active_seconds:        activeSecs,
                        lines_added:           linesAdded,
                        lines_deleted:         linesDeleted,
                        lines_modified:        linesModified,
                        raw_code_changes:      JSON.stringify(sanitizedChanges),
                        last_commit_hash:      rec.lastCommitHash       || 'none',
                        last_commit_message:   rec.lastCommitMessage    || '',
                        last_commit_timestamp: rec.lastCommitTimestamp  || '',
                        last_commit_status:    rec.lastCommitStatus     || 'unknown',
                        recorded_at:           batchTimestamp,
                    },
                    { transaction: t }
                );
            }
        });

        await upsertProjects(userId, events, batchTimestamp);
        try { notifyTelemetryUpdate(userId); } catch (e) { console.error('[ws] notification failed:', e); }

        return res.status(200).json({ status: 'success', inserted: events.length });
    } catch (err) {
        console.error('[telemetry] ingest error:', err);
        return res.status(500).json({ error: 'Failed to ingest telemetry' });
    }
}

async function upsertProjects(userId, events, timestamp) {
    const seen = new Set();
    for (const rec of events) {
        const projectName = resolveProjectName(rec);
        if (seen.has(projectName)) continue;
        seen.add(projectName);

        const existing = await Project.findOne({
            where: { user_id: userId, repo_name: projectName },
        });

        if (existing) {
            await existing.update({
                last_seen:             timestamp,
                status:                'in_progress',
                last_commit_hash:      rec.lastCommitHash      || 'none',
                last_commit_message:   rec.lastCommitMessage   || '',
                last_commit_timestamp: rec.lastCommitTimestamp || '',
                last_commit_status:    rec.lastCommitStatus    || 'unknown',
            });
        } else {
            await Project.create({
                user_id:               userId,
                name:                  projectName,
                repo_name:             projectName,
                framework:             rec.projectFramework || 'none',
                first_seen:            timestamp,
                last_seen:             timestamp,
                last_commit_hash:      rec.lastCommitHash      || 'none',
                last_commit_message:   rec.lastCommitMessage   || '',
                last_commit_timestamp: rec.lastCommitTimestamp || '',
                last_commit_status:    rec.lastCommitStatus    || 'unknown',
            });
        }
    }
}

async function getSummary(req, res) {
    const userId = req.user.id;
    const to   = req.query.to   ? new Date(req.query.to)   : new Date();
    const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 86400000);

    const rows = await sequelize.query(`
        SELECT
            project_name,
            language_id,
            git_branch,
            SUM(active_seconds)  AS total_seconds,
            SUM(lines_added)     AS total_added,
            SUM(lines_deleted)   AS total_deleted,
            SUM(lines_modified)  AS total_modified,
            COUNT(*)             AS sessions
        FROM telemetry
        WHERE user_id = :userId AND recorded_at BETWEEN :from AND :to
        GROUP BY project_name, language_id, git_branch
        ORDER BY total_seconds DESC
    `, {
        replacements: { userId, from, to },
        type: QueryTypes.SELECT,
    });

    return res.json({ from, to, summary: rows });
}

module.exports = { ingestActivity, getSummary };