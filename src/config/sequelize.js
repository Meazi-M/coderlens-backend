const { Sequelize } = require('sequelize');

// Neon / Cloud Postgres connection setup
// Stripping query params (like ?sslmode=require) prevents conflicts with node-pg's dialectOptions.ssl
const rawUrl = process.env.DATABASE_URL;
const connectionUrl = rawUrl ? rawUrl.split('?')[0] : null;

const sequelize = connectionUrl
    ? new Sequelize(connectionUrl, {
          dialect: 'postgres',
          logging: false,
          dialectOptions: {
              ssl: {
                  require:            true,
                  rejectUnauthorized: false,
              },
          },
          pool: { max: 10, min: 0, acquire: 30000, idle: 10000 },
      })
    : new Sequelize(
          process.env.DB_NAME  || 'coderlens',
          process.env.DB_USER  || 'postgres',
          process.env.DB_PASS  || 'postgres',
          {
              host:    process.env.DB_HOST || 'localhost',
              port:    parseInt(process.env.DB_PORT || '5432', 10),
              dialect: 'postgres',
              logging: false,
              pool: { max: 10, min: 0, acquire: 30000, idle: 10000 },
          }
      );

module.exports = sequelize;
