const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;
const DB_PATH = path.join(__dirname, 'data', 'db.json');

app.use(cors());
app.use(express.json());

// Ensure the db.json file exists
function ensureDbExists() {
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(DB_PATH)) {
        fs.writeFileSync(DB_PATH, JSON.stringify([], null, 2));
    }
}

// Read database records
function getActivities() {
    try {
        ensureDbExists();
        const data = fs.readFileSync(DB_PATH, 'utf-8');
        return JSON.parse(data);
    } catch (error) {
        return [];
    }
}

// Ingestion API Route matching our previous structure
app.post('/api/activity', (req, res) => {
    try {
        const body = req.body;
        const batchTimestamp = body.timestamp || new Date().toISOString();
        const events = body.events || [];
        
        if (Array.isArray(events) && events.length > 0) {
            ensureDbExists();
            const currentRecords = getActivities();
            
            const formattedRecords = events.map(rec => ({
                filePath: rec.filePath || '',
                fileName: rec.fileName || '',
                languageId: rec.languageId || rec.language || 'unknown',
                activeSeconds: Number(rec.activeSeconds) || 0,
                linesAdded: Number(rec.linesAdded) || 0,
                linesDeleted: Number(rec.linesDeleted) || 0,
                linesModified: Number(rec.linesModified) || 0,
                gitBranch: rec.gitBranch || 'none',
                gitRepo: rec.gitRepo || 'local',
                projectFramework: rec.projectFramework || 'none',
                rawCodeChanges: rec.rawCodeChanges || rec.changes || [],
                timestamp: batchTimestamp
            }));
            
            const updatedRecords = [...currentRecords, ...formattedRecords];
            fs.writeFileSync(DB_PATH, JSON.stringify(updatedRecords, null, 2), 'utf-8');
            console.log(`Successfully persisted ${formattedRecords.length} records to local DB.`);
        }
        
        res.status(200).json({ status: 'success', message: 'Telemetry received and persisted' });
    } catch (error) {
        console.error('API Error:', error.message);
        res.status(400).json({ status: 'error', message: 'Invalid JSON payload' });
    }
});

app.listen(PORT, () => {
    console.log(`CoderLens Express API running at http://localhost:${PORT}`);
});
