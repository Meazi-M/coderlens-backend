const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const GitHubStrategy = require('passport-github2').Strategy;
const { User } = require('./db');
const { signToken } = require('../features/auth/auth.middleware');

async function upsertOAuthUser({ provider, oauthId, email, name, avatarUrl, role }) {
    // Try to find by OAuth provider + id first
    let user = await User.findOne({ where: { oauth_provider: provider, oauth_id: oauthId } });

    // If not found, try matching by email and link the OAuth identity
    if (!user && email) {
        user = await User.findOne({ where: { email } });
        if (user) {
            await user.update({ oauth_provider: provider, oauth_id: oauthId, avatar_url: avatarUrl });
            user = await user.reload();
        }
    }

    // Create a new user if still not found
    if (!user) {
        user = await User.create({
            name,
            email:          email || null,
            role:           role  || 'developer',
            avatar_url:     avatarUrl || null,
            oauth_provider: provider,
            oauth_id:       oauthId,
        });
    }

    await user.update({ last_seen: new Date() });

    const { password: _, ...safeUser } = user.toJSON();
    return { user: safeUser, token: signToken(safeUser) };
}

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    passport.use(new GoogleStrategy(
        {
            clientID:          process.env.GOOGLE_CLIENT_ID,
            clientSecret:      process.env.GOOGLE_CLIENT_SECRET,
            callbackURL:       process.env.GOOGLE_CALLBACK_URL,
            passReqToCallback: true,
        },
        async (req, _at, _rt, profile, done) => {
            try {
                const role = req.query.state || 'developer';
                const result = await upsertOAuthUser({
                    provider:  'google',
                    oauthId:   profile.id,
                    email:     profile.emails?.[0]?.value || null,
                    name:      profile.displayName,
                    avatarUrl: profile.photos?.[0]?.value || null,
                    role,
                });
                done(null, result);
            } catch (err) {
                done(err);
            }
        }
    ));
    console.log('✅ Google OAuth enabled');
} else {
    console.log('⚠️  Google OAuth disabled (missing credentials)');
}

if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) {
    passport.use(new GitHubStrategy(
        {
            clientID:          process.env.GITHUB_CLIENT_ID,
            clientSecret:      process.env.GITHUB_CLIENT_SECRET,
            callbackURL:       process.env.GITHUB_CALLBACK_URL,
            scope:             ['user:email'],
            passReqToCallback: true,
        },
        async (req, _at, _rt, profile, done) => {
            try {
                const role = req.query.state || 'developer';
                const result = await upsertOAuthUser({
                    provider:  'github',
                    oauthId:   String(profile.id),
                    email:     profile.emails?.[0]?.value || null,
                    name:      profile.displayName || profile.username,
                    avatarUrl: profile.photos?.[0]?.value || null,
                    role,
                });
                done(null, result);
            } catch (err) {
                done(err);
            }
        }
    ));
    console.log('✅ GitHub OAuth enabled');
} else {
    console.log('⚠️  GitHub OAuth disabled (missing credentials)');
}

passport.serializeUser((data, done) => done(null, data));
passport.deserializeUser((data, done) => done(null, data));

module.exports = passport;