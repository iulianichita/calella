require('dotenv').config();
const express = require("express");
const path = require("path");
const crypto = require('crypto');
const session = require('express-session');
const eventTemplates = require('./eventTemplates');

// posters
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');
const posterTemplates = require('./posterTemplates');

try { GlobalFonts.registerFromPath(path.join(__dirname, 'fonts', 'Poster.ttf'), 'Poster'); } catch (e) {}

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);
app.use(express.json());
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, secure: 'auto', sameSite: 'lax' }
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

    const now = Date.now();
    const existing = Array.isArray(req.session.oauthAttempts) ? req.session.oauthAttempts : [];
    // Keep a short queue of recent OAuth attempts so parallel clicks/tabs do not break state validation.
    req.session.oauthAttempts = [...existing, { state, verifier, createdAt: now }]
        .filter(x => now - x.createdAt < 15 * 60 * 1000)
        .slice(-10);

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
    req.session.save(err => {
        if (err) return res.status(500).send('Could not start OAuth flow');
        res.redirect(`https://auth.buffer.com/auth?${params}`);
    });
});


app.get('/auth/buffer/callback', async (req, res) => {
    const { code, state, error } = req.query;
    console.log('cookie primit:', !!req.headers.cookie, 'attempts:', req.session.oauthAttempts?.length, 'state primit:', state);
    if (error) return res.redirect('/home');

    const attempts = Array.isArray(req.session.oauthAttempts) ? req.session.oauthAttempts : [];
    const now = Date.now();
    const validAttempts = attempts.filter(x => now - x.createdAt < 15 * 60 * 1000);
    const match = validAttempts.find(x => x.state === state);
    if (!match) return res.status(403).send('Invalid state');

    req.session.oauthAttempts = validAttempts.filter(x => x.state !== state);

    const r = await fetch('https://auth.buffer.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
        client_id: process.env.BUFFER_CLIENT_ID,
        client_secret: process.env.BUFFER_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: process.env.REDIRECT_URI,
        code_verifier: match.verifier
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
            name: account.name,
            email: account.email,
            channels,
            events: req.session.events || [],
            templates: Object.fromEntries(Object.entries(eventTemplates)
                .map(([k, t]) => [k, { name: t.name, fields: t.fields, kind: t.kind || 'legacy' }])),
            posters: Object.fromEntries(Object.entries(posterTemplates)
                .map(([k, p]) => [k, { name: p.name, url: p.url }])),
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
    const {
        name,
        description = '',
        template,
        dates = {},
        options = {},
        channelIds = [],
        tags = [],
        poster = ''
    } = req.body;
    
    const t = eventTemplates[template];
    const chans = (req.session.channels || []).filter(c => channelIds.includes(c.id));
    if (!t || !chans.length) return res.status(400).json({ error: 'Pick a template and a channel' });

    const results = [];
    const base = `${req.protocol}://${req.get('host')}`;
    const fmtDate = d => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });

    try {
        const templatePosts = typeof t.buildPosts === 'function'
            ? t.buildPosts({ name, description, dates, options })
            : t.posts;

        for (const p of templatePosts) {
            const due = p.dueDate
                ? new Date(`${p.dueDate}T10:00:00.000Z`)
                : new Date(`${dates[p.at]}T10:00:00.000Z`);

            if (!p.dueDate) {
                due.setUTCDate(due.getUTCDate() + p.days);
            }

            if (isNaN(due) || due < new Date()) {
                results.push({ title: p.title, status: 'skipped (date passed)' });
                continue;
            }

            for (const ch of chans) {
                const text = adapt(ch.service, p.text({ name, description, dates }), tags);
                const imageUrl = poster ? `${base}/api/poster.png?${new URLSearchParams({
                    bg: poster,
                    eyebrow: name,
                    headline: p.title,
                    line: p.lineDate ? fmtDate(p.lineDate) : (p.days <= 0 ? fmtDate(dates[p.at]) : '')
                })}` : null;

                const data = await buffer(req, `mutation { createPost(input: {
                    text: ${JSON.stringify(text)}, channelId: ${JSON.stringify(ch.id)},
                    schedulingType: automatic, mode: customScheduled, dueAt: ${JSON.stringify(due.toISOString())}
                    ${imageUrl ? `, assets: [{ image: { url: ${JSON.stringify(imageUrl)} } }]` : ''}
                    }) { ... on PostActionSuccess { post { id dueAt } } ... on MutationError { message } } }`);

                const r = data.createPost;

                results.push({ title: p.title, channel: ch.name, dueAt: due, image: imageUrl, status: r.post ? 'scheduled' : r.message });
            }
        }

        req.session.events = [...(req.session.events || []), { name, template: t.name, posts: results.length }];
        res.json({ results });
    } catch (e) { res.status(e.status || 500).json({ error: e.message, results }); }
});

// poster generator
const bgCache = new Map();
async function getBg(key) {
    if (!bgCache.has(key)) {
        const r = await fetch(posterTemplates[key].url);
        if (!r.ok) throw new Error('Cannot load template image');
        bgCache.set(key, await loadImage(Buffer.from(await r.arrayBuffer())));
    }
    return bgCache.get(key);
}

function wrap(ctx, text, maxW) {
    const lines = []; let line = '';
    for (const w of text.split(/\s+/)) {
        const test = line ? `${line} ${w}` : w;
        if (ctx.measureText(test).width > maxW && line) { lines.push(line); line = w; }
        else line = test;
    }
    if (line) lines.push(line);
    return lines;
}

async function renderPoster({ bg, eyebrow, headline, line, debug }) {
    const tpl = posterTemplates[bg];
    const img = await getBg(bg);
    const canvas = createCanvas(img.width, img.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);

    const z = {
        x: tpl.zone.x * img.width, y: tpl.zone.y * img.height,
        w: tpl.zone.w * img.width, h: tpl.zone.h * img.height
    };
    if (debug) { ctx.strokeStyle = 'red'; ctx.lineWidth = 4; ctx.strokeRect(z.x, z.y, z.w, z.h); }

    ctx.fillStyle = tpl.color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const family = 'Poster, sans-serif';

    const blocks = [
        { text: eyebrow && eyebrow.toUpperCase(), k: 0.45 },
        { text: headline, k: 1.4 },
        { text: line, k: 0.7 }
    ].filter(b => b.text);

    // micsoreaza fontul
    let S = img.width * 0.07, layout = [], h = 0;
    for (; S >= 14; S -= 2) {
        layout = []; h = 0;
        for (const b of blocks) {
            const size = S * b.k;
            ctx.font = `${size}px ${family}`;
            const lines = wrap(ctx, b.text, z.w);
            const lh = size * 1.2;
            layout.push({ lines, size, lh });
            h += lines.length * lh + size * 0.5;
        }
        if (h <= z.h) break;
    }

    let y = z.y + (z.h - h) / 2;
    for (const l of layout) {
        ctx.font = `${l.size}px ${family}`;
        for (const t of l.lines) { ctx.fillText(t, z.x + z.w / 2, y); y += l.lh; }
        y += l.size * 0.5;
    }
    return canvas.toBuffer('image/png');
}

// buffer descarca imaginea de aici
app.get('/api/poster.png', async (req, res) => {
    try {
        const { bg, eyebrow = '', headline = '', line = '', debug } = req.query;
        if (!posterTemplates[bg]) return res.status(400).send('Unknown design');
        const png = await renderPoster({
            bg,
            eyebrow: eyebrow.slice(0, 80),
            headline: headline.slice(0, 80),
            line: line.slice(0, 120),
            debug: !!debug
        });
        res.type('png').set('Cache-Control', 'public, max-age=3600').send(png);
    } catch (e) { res.status(500).send(e.message); }
});


app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});