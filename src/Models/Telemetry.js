const { DataTypes } = require('sequelize');
const sequelize = require('../config/sequelize');
const User = require('./User');

const Telemetry = sequelize.define('Telemetry', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
    },
    user_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: { model: User, key: 'id' },
    },
    file_path: {
        type: DataTypes.TEXT,
        allowNull: false,
    },
    file_name: {
        type: DataTypes.TEXT,
        allowNull: false,
    },
    language_id: {
        type: DataTypes.STRING,
        allowNull: true,
    },
    project_name: {
        type: DataTypes.TEXT,
        allowNull: true,
    },
    project_framework: {
        type: DataTypes.STRING,
        allowNull: true,
    },
    git_branch: {
        type: DataTypes.STRING,
        allowNull: true,
    },
    git_repo: {
        type: DataTypes.TEXT,
        allowNull: true,
    },
    active_seconds: {
        type: DataTypes.FLOAT,
        allowNull: false,
        defaultValue: 0,
    },
    lines_added: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
    },
    lines_deleted: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
    },
    lines_modified: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
    },
    raw_code_changes: {
        type: DataTypes.TEXT,
        allowNull: true,
    },
    last_commit_hash: {
        type: DataTypes.STRING,
        allowNull: true,
    },
    last_commit_message: {
        type: DataTypes.TEXT,
        allowNull: true,
    },
    last_commit_timestamp: {
        type: DataTypes.STRING,
        allowNull: true,
    },
    last_commit_status: {
        type: DataTypes.STRING,
        allowNull: true,
    },
    recorded_at: {
        type: DataTypes.DATE,
        allowNull: false,
    },
}, {
    tableName: 'telemetry',
    timestamps: false,
    indexes: [
        { fields: ['user_id', 'recorded_at'] },
        { fields: ['user_id', 'project_name'] },
    ],
});

Telemetry.belongsTo(User, { foreignKey: 'user_id' });

module.exports = Telemetry;
