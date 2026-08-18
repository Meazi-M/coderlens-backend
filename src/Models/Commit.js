const { DataTypes } = require('sequelize');
const sequelize = require('../config/sequelize');
const User = require('./User');

const Commit = sequelize.define('Commit', {
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
    project_name: {
        type: DataTypes.TEXT,
        allowNull: false,
    },
    git_branch: {
        type: DataTypes.STRING,
        allowNull: true,
    },
    git_repo: {
        type: DataTypes.TEXT,
        allowNull: true,
    },
    commit_hash: {
        type: DataTypes.STRING,
        allowNull: false,
    },
    commit_message: {
        type: DataTypes.TEXT,
        allowNull: true,
    },
    committed_at: {
        type: DataTypes.DATE,
        allowNull: false,
    },
}, {
    tableName: 'commits',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: false,
    indexes: [
        { unique: true, fields: ['user_id', 'project_name', 'commit_hash'] },
        { fields: ['user_id', 'committed_at'] },
    ],
});

Commit.belongsTo(User, { foreignKey: 'user_id' });

module.exports = Commit;
