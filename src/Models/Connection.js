const { DataTypes } = require('sequelize');
const sequelize = require('../config/sequelize');
const User = require('./User');

const Connection = sequelize.define('Connection', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
    },
    recruiter_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: { model: User, key: 'id' },
    },
    developer_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: { model: User, key: 'id' },
    },
    status: {
        type: DataTypes.ENUM('pending', 'active', 'paused', 'terminated'),
        allowNull: false,
        defaultValue: 'pending',
    },
    paused_by: {
        type: DataTypes.STRING,
        allowNull: true, // 'developer' | 'recruiter' | null
    },
    paused_at: {
        type: DataTypes.DATE,
        allowNull: true,
    },
    pause_intervals: {
        type: DataTypes.TEXT,
        allowNull: true, // JSON string array of { start: string, end: string }
        defaultValue: '[]',
    },
    initiated_at: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
    },
    responded_at: {
        type: DataTypes.DATE,
        allowNull: true,
    },
    terminated_at: {
        type: DataTypes.DATE,
        allowNull: true,
    },
}, {
    tableName: 'connections',
    timestamps: false,
    indexes: [
        { unique: true, fields: ['recruiter_id', 'developer_id'] },
        { fields: ['recruiter_id', 'status'] },
        { fields: ['developer_id', 'status'] },
    ],
});

// Associations
Connection.belongsTo(User, { as: 'recruiter', foreignKey: 'recruiter_id' });
Connection.belongsTo(User, { as: 'developer', foreignKey: 'developer_id' });

module.exports = Connection;
