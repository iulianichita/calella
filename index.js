require('dotenv').config();
const express = require("express");
const path = require("path");
const crypto = require('crypto');
const session = require('express-session');
const eventTemplates = require('./eventTemplates');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);
app.use(express.json());
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' }
}));

app.use(express.static(path.join(__dirname, 'templates')));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'templates/home.html')));
app.get('/home', (req, res) => res.sendFile(path.join(__dirname, 'templates/home.html')));
app.get('/profile', (req, res) => res.sendFile(path.join(__dirname, 'templates/dashboard.html')));


// Buffer OAuth
const b64url = (buf) => buf.toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

// butonul "connect buffer"
app.get('/auth/buffer', (req, res) => {
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const state = b64url(crypto.randomBytes(16));

    req.session.codeVerifier = verifier;
    req.session.oauthState = state;

    const params = new URLSearchParams({
        client_id: process.env.BUFFER_CLIENT_ID,
        redirect_uri: process.env.REDIRECT_URI,
        response_type: 'code',
        scope: 'posts:write posts:read account:read offline_access',
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        prompt: 'consent'
    });
    res.redirect(`https://auth.buffer.com/auth?${params}`);
});


app.get('/auth/buffer/callback', async (req, res) => {
    const { code, state, error } = req.query;
    if (error) return res.redirect('/home');
    if (state !== req.session.oauthState) return res.status(403).send('Invalid state');

    const r = await fetch('https://auth.buffer.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
        client_id: process.env.BUFFER_CLIENT_ID,
        client_secret: process.env.BUFFER_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: process.env.REDIRECT_URI,
        code_verifier: req.session.codeVerifier
        })
    });
    const tokens = await r.json();
    if (!tokens.access_token) return res.status(400).json(tokens);

    req.session.buffer = {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: Date.now() + (tokens.expires_in - 60) * 1000
    };
    res.redirect('/profile');
});

app.get('/api/buffer/status', (req, res) => {
    res.json({ connected: !!req.session.buffer });
});

app.get('/auth/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/home'));
});

// apeluri catre buffer api
async function buffer(req, query) {
    const b = req.session.buffer;
    if (!b || Date.now() > b.expiresAt) {
        throw Object.assign(new Error('Not connected'), { status: 401 });
    }
    const r = await fetch('https://api.buffer.com', {
        method: 'POST',
        headers: { Authorization: `Bearer ${b.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query })
    });
    if (r.status === 401) throw Object.assign(new Error('Not connected'), { status: 401 });
    const json = await r.json();
    if (json.errors) throw new Error(json.errors[0].message);
    return json.data;
}

app.get('/api/me', async (req, res) => {
    try {
        const { account } = await buffer(req, '{ account { id email organizations { id name } } }');
        const org = account.organizations[0];
        const { channels } = await buffer(req,
            `{ channels(input: { organizationId: ${JSON.stringify(org.id)} }) { id name service } }`);
        req.session.channels = channels;

        res.json({
            email: account.email,
            channels,
            events: req.session.events || [],
            templates: Object.fromEntries(Object.entries(eventTemplates)
                .map(([k, t]) => [k, { name: t.name, fields: t.fields }]))
        });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// create event
const adapt = (service, text, tags) => {
    const hashtags = tags.map(t => '#' + t.replace(/\W/g, '')).join(' ');

    if (service === 'linkedin') return `${text}\n\n${hashtags}`.trim();
    if (service === 'twitter') return text.slice(0, 240);

    return `${text}\n\n${hashtags}`.trim();
};

app.post('/api/events', async (req, res) => {
    const { name, description = '', template, dates, channelIds = [], tags = [] } = req.body;
    
    const t = eventTemplates[template];
    const chans = (req.session.channels || []).filter(c => channelIds.includes(c.id));
    if (!t || !chans.length) return res.status(400).json({ error: 'Pick a template and a channel' });

    const results = [];

    try {
        for (const p of t.posts) {
            const due = new Date(`${dates[p.at]}T10:00:00.000Z`);
            due.setUTCDate(due.getUTCDate() + p.days);
            if (isNaN(due) || due < new Date()) {
                results.push({ title: p.title, status: 'skipped (date passed)' });
                continue;
            }

            for (const ch of chans) {
                const text = adapt(ch.service, p.text({ name, description, dates }), tags);
                const data = await buffer(req, `mutation { createPost(input: {
                    text: ${JSON.stringify(text)}, channelId: ${JSON.stringify(ch.id)},
                    schedulingType: automatic, mode: customScheduled, dueAt: ${JSON.stringify(due.toISOString())}
                    }) { ... on PostActionSuccess { post { id dueAt } } ... on MutationError { message } } }`);
                
                const r = data.createPost;

                results.push({ title: p.title, channel: ch.name, dueAt: due, status: r.post ? 'scheduled' : r.message });
            }
        }

        req.session.events = [...(req.session.events || []), { name, template: t.name, posts: results.length }];
        res.json({ results });
    } catch (e) { res.status(e.status || 500).json({ error: e.message, results }); }
});


app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});