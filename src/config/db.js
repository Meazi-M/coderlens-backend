// db.js — Sequelize ORM initializer (PostgreSQL)
// Imports all models to register them with the sequelize instance, then
// calls sequelize.sync({ alter: true }) so the schema is kept up to date
// automatically without dropping data.

const sequelize = require('./sequelize');

// Register all models
const User       = require('../Models/User');
const Connection = require('../Models/Connection');
const Telemetry  = require('../Models/Telemetry');
const Project    = require('../Models/Project');
const Commit     = require('../Models/Commit');

async function initDb() {
    try {
        await sequelize.authenticate();
        console.log('[db] PostgreSQL connection established ✅');

        // alter: true will add missing columns/indexes without dropping data
        await sequelize.sync({ alter: true });
        console.log('[db] All models synced with PostgreSQL ✅');
    } catch (err) {
        console.error('[db] Unable to connect to PostgreSQL ❌', err);
        process.exit(1);
    }
}

module.exports = { sequelize, initDb, User, Connection, Telemetry, Project, Commit };