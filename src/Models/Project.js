const { DataTypes } = require('sequelize');
const sequelize = require('../config/sequelize');
const User = require('./User');

const Project = sequelize.define('Project', {
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
    name: {
        type: DataTypes.TEXT,
        allowNull: false,
    },
    description: {
        type: DataTypes.TEXT,
        allowNull: true,
    },
    repo_name: {
        type: DataTypes.TEXT,
        allowNull: true,
    },
    framework: {
        type: DataTypes.STRING,
        allowNull: true,
    },
    status: {
        type: DataTypes.ENUM('planned', 'in_progress', 'on_hold', 'shipped'),
        allowNull: false,
        defaultValue: 'in_progress',
    },
    is_manual: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
    },
    first_seen: {
        type: DataTypes.DATE,
        allowNull: true,
    },
    last_seen: {
        type: DataTypes.DATE,
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
}, {
    tableName: 'projects',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: false,
    indexes: [
        { fields: ['user_id'] },
    ],
});

Project.belongsTo(User, { foreignKey: 'user_id' });

module.exports = Project;
