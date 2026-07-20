const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const GitHubStrategy = require('passport-github2').Strategy;
const db = require('./db');
const { signToken } = require('../features/auth/auth.middleware');

function upsertOAuthUser({ provider, oauthId, email, name, avatarUrl, role }) {
    let user = db.prepare(
        'SELECT * FROM users WHERE oauth_provider = ? AND oauth_id = ?'
    ).get(provider, oauthId);

    if (!user && email) {
        user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
        if (user) {
            db.prepare(
                'UPDATE users SET oauth_provider = ?, oauth_id = ?, avatar_url = ? WHERE id = ?'
            ).run(provider, oauthId, avatarUrl, user.id);
            user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
        }
    }

    if (!user) {
        const result = db.prepare(`
            INSERT INTO users (name, email, role, avatar_url, oauth_provider, oauth_id)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(name, email || null, role || 'developer', avatarUrl || null, provider, oauthId);
        user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
    }

    db.prepare("UPDATE users SET last_seen = datetime('now') WHERE id = ?").run(user.id);

    const { password: _, ...safeUser } = user;
    return { user: safeUser, token: signToken(safeUser) };
}

passport.use(new GoogleStrategy(
    {
        clientID:     process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL:  process.env.GOOGLE_CALLBACK_URL,
        passReqToCallback: true,
    },
    (req, _at, _rt, profile, done) => {
        const role = req.query.state || 'developer';
        done(null, upsertOAuthUser({
            provider: 'google',
            oauthId: profile.id,
            email: profile.emails?.[0]?.value || null,
            name: profile.displayName,
            avatarUrl: profile.photos?.[0]?.value || null,
            role,
        }));
    }
));

passport.use(new GitHubStrategy(
    {
        clientID:     process.env.GITHUB_CLIENT_ID,
        clientSecret: process.env.GITHUB_CLIENT_SECRET,
        callbackURL:  process.env.GITHUB_CALLBACK_URL,
        scope: ['user:email'],
        passReqToCallback: true,
    },
    (req, _at, _rt, profile, done) => {
        const role = req.query.state || 'developer';
        done(null, upsertOAuthUser({
            provider: 'github',
            oauthId: String(profile.id),
            email: profile.emails?.[0]?.value || null,
            name: profile.displayName || profile.username,
            avatarUrl: profile.photos?.[0]?.value || null,
            role,
        }));
    }
));

passport.serializeUser((data, done) => done(null, data));
passport.deserializeUser((data, done) => done(null, data));

module.exports = passport;