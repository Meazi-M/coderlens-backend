const { DataTypes } = require('sequelize');
const sequelize = require('../config/sequelize');

const User = sequelize.define('User', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
    },
    name: {
        type: DataTypes.STRING,
        allowNull: false,
    },
    email: {
        type: DataTypes.STRING,
        allowNull: true,
        unique: true,
    },
    password: {
        type: DataTypes.STRING,
        allowNull: true,
    },
    role: {
        type: DataTypes.ENUM('developer', 'recruiter'),
        allowNull: false,
    },
    avatar_url: {
        type: DataTypes.TEXT,
        allowNull: true,
    },
    oauth_provider: {
        type: DataTypes.STRING,
        allowNull: true,
    },
    oauth_id: {
        type: DataTypes.STRING,
        allowNull: true,
    },
    last_seen: {
        type: DataTypes.DATE,
        allowNull: true,
    },
}, {
    tableName: 'users',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: false,
});

module.exports = User;
