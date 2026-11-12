require('dotenv').config();
const express = require("express");
const path = require("path");
const crypto = require('crypto');
const session = require('express-session');
const eventTemplates = require('./eventTemplates');
const fs = require('fs');
const https = require('https');

// save the events in mongodb
const mongoose = require('mongoose');
const MongoStore = require('connect-mongo').default;
const Event = require('./models/Event');

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
    store: MongoStore.create({ mongoUrl: process.env.MONGODB_URI }),
    cookie: { httpOnly: true, secure: 'auto', sameSite: 'lax' }
}));

app.use(express.static(path.join(__dirname, 'templates')));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'templates/home.html')));
app.get('/home', (req, res) => res.sendFile(path.join(__dirname, 'templates/home.html')));
app.get('/profile', (req, res) => res.sendFile(path.join(__dirname, 'templates/dashboard.html')));
app.get('/learn', (req, res) => res.sendFile(path.join(__dirname, 'templates/learn.html')));


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
    // console.log('cookie primit:', !!req.headers.cookie, 'attempts:', req.session.oauthAttempts?.length, 'state primit:', state);
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
    let r;
    try {
        r = await fetch('https://api.buffer.com', {
            method: 'POST',
            headers: { Authorization: `Bearer ${b.accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ query }),
            signal: AbortSignal.timeout(25000)
        });
    } catch (e) {
        if (e.name === 'TimeoutError') {
            throw new Error('Buffer API timeout after 25 seconds');
        }
        throw e;
    }
    if (r.status === 401) throw Object.assign(new Error('Not connected'), { status: 401 });
    const json = await r.json();
    if (json.errors) throw new Error(json.errors[0].message);
    return json.data;
}

//helpers
async function createBufferPost(req, { text, channelId, service, dueAt, imageUrl }) {
    const data = await buffer(req, `
        mutation {
            createPost(
                input: {
                    text: ${JSON.stringify(text)},
                    channelId: ${JSON.stringify(channelId)},
                    schedulingType: automatic,
                    mode: customScheduled,
                    dueAt: ${JSON.stringify(new Date(dueAt).toISOString())}
                    ${service === 'instagram' ? ', metadata: { instagram: { type: post, shouldShareToFeed: true } }' : ''}
                    ${imageUrl ? `, assets: [{ image: { url: ${JSON.stringify(imageUrl)} } }]` : ''}
                }
            ) {
                ... on PostActionSuccess { post { id dueAt } }
                ... on MutationError { message }
            }
        }
    `);
    const r = data.createPost;
    return { id: r.post?.id || null, error: r.post ? null : r.message };
}

async function deleteBufferPost(req, id) {
    if (!id || String(id) === '1') return;
    try {
        const data = await buffer(req, `
            mutation {
                deletePost(input: { id: ${JSON.stringify(String(id))} }) {
                    __typename
                    ... on VoidMutationError { message }
                }
            }
        `);
        if (data.deletePost.message) throw new Error(data.deletePost.message);
    } catch (e) {
        if (e.status === 401) throw e; // sesiune expirata: oprim tot
        console.warn('Buffer delete failed for', id, '-', e.message);
    }
}

app.get('/api/me', async (req, res) => {
    try {
        // const { account } = await buffer(req, '{ account { id email name organizations { id name } } }');
        // const org = account.organizations[0];
        // const { channels } = await buffer(req,
        //     `{ channels(input: { organizationId: ${JSON.stringify(org.id)} }) { id name service } }`);
        const CACHE_MS = 5 * 60 * 1000;
        let cache = req.session.meCache;

        if (!cache || Date.now() - cache.at > CACHE_MS) {
            const { account } = await buffer(req, '{ account { id email name organizations { id name } } }');
            const org = account.organizations[0];
            const { channels } = await buffer(req,
                `{ channels(input: { organizationId: ${JSON.stringify(org.id)} }) { id name service } }`);
            cache = { at: Date.now(), account, channels };
            req.session.meCache = cache;
        }

        const { account, channels } = cache;
        req.session.channels = channels;
        req.session.userId = account.id;

        const events = await Event.find({ userId: account.id }).sort({ createdAt: -1 });
        // console.log(account);

        res.json({
            name: account.name,
            email: account.email,
            channels,
            events: events.map(e => ({
                id: e._id,
                name: e.name,
                template: e.template,
                description: e.description,
                poster: e.poster,
                dates: e.dates ? Object.fromEntries(e.dates.entries()) : {},
                options: e.options || {},
                posts: e.posts.filter(p => p.status === 'scheduled').length,
                postDetails: e.posts.map(p => ({
                    id: p._id,
                    title: p.title,
                    text: p.text,
                    channelName: p.channelName,
                    channelService: p.channelService,
                    dueAt: p.dueAt,
                    imageUrl: p.imageUrl,
                    status: p.status
                }))
            })),
            templates: Object.fromEntries(Object.entries(eventTemplates)
                .map(([k, t]) => [k, { name: t.name, fields: t.fields, kind: t.kind || 'legacy' }])),
            posters: Object.fromEntries(Object.entries(posterTemplates)
                .map(([k, p]) => [k, { name: p.name, url: p.url }])),
        });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.get('/api/events/:id', async (req, res) => {
    try {
        if (!req.session.buffer || !req.session.userId) {
            return res.status(401).json({ error: 'Not connected' });
        }

        const event = await Event.findOne({ _id: req.params.id, userId: req.session.userId });
        if (!event) return res.status(404).json({ error: 'Event not found' });

        res.json({
            id: event._id,
            name: event.name,
            description: event.description || '',
            template: Object.keys(eventTemplates).find(k => eventTemplates[k].name === event.template) || event.template,
            poster: event.poster || '',
            dates: event.dates ? Object.fromEntries(event.dates.entries()) : {},
            options: event.options || {},
            tags: event.tags || [],
            channelIds: event.channelIds || [],
            posts: (event.posts || []).map(p => ({
                id: p._id,
                title: p.title,
                text: p.text,
                channelId: p.channelId,
                channelName: p.channelName,
                channelService: p.channelService,
                dueAt: p.dueAt,
                imageUrl: p.imageUrl,
                status: p.status
            }))
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.put('/api/events/:id', async (req, res) => {
    try {
        if (!req.session.buffer || !req.session.userId) {
            return res.status(401).json({ error: 'Not connected' });
        }

        const event = await Event.findOne({ _id: req.params.id, userId: req.session.userId });
        if (!event) return res.status(404).json({ error: 'Event not found' });

        const {
            name,
            description = '',
            template,
            dates = {},
            options = {},
            poster = '',
            posts = []
        } = req.body || {};

        if (!template || !eventTemplates[template]) {
            return res.status(400).json({ error: 'Unknown event template' });
        }
        const templateName = eventTemplates[template].name;
        const templateKind = eventTemplates[template].kind || 'legacy';

        // to do
        // const base = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
        const base = `${req.protocol}://${req.get('host')}`;
        const fmtDate = d => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });
        const finalName = name || event.name;
        
        // console.log(event);
        // console.log(req.body);

        // reface caption (text field)
        const fmtShort = d => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });

        const textForTitle = title => {
            if (title === 'Event announcement') {
                return `${name} is coming on ${fmtShort(dates.eventDay)}. ${description}`.trim();
            }
            if (title === 'Event day') {
                return `Today is the day: ${name}!`;
            }
            if (title === 'Thank you') {
                return (options.thankYouText || '').trim() || `Thank you to everyone who joined ${finalName}.`;
            }
            return null;
        };

        const nextPosts = posts.map(post => {
            const rawText = textForTitle(post.title);
            const serviceKey = (post.channelService || '').toLowerCase();
            const captions = rawText !== null
                ? generateCaptionsForPlatforms(name, rawText, event.tags)
                : null;
            const posterDescription = (templateKind === 'single-stage' && post.title === 'Thank you')
                ? ((options.thankYouText || '').trim() || description)
                : description;

            return {
                title: post.title || 'Untitled post',
                text: captions
                    ? (captions[serviceKey] || captions.facebook)
                    : (post.text ?? ''),
                channelId: post.channelId || '',
                channelName: post.channelName || '',
                channelService: post.channelService || '',
                dueAt: withPlatformPostingTime(post.dueAt, post.channelService),
                imageUrl: poster ? `${base}/api/poster.png?${new URLSearchParams({
                    bg: poster,
                    eyebrow: finalName,
                    headline: post.title || '',
                    description: posterDescription,
                    line: post.dueAt ? fmtDate(post.dueAt) : ''
                })}` : '',
                status: post.status || 'scheduled'
            }
        });

        let finalPosts = nextPosts;

        if (templateKind === 'single-stage') {
            // canalele deja folosite in event (unice)
            const eventChannels = [...new Map(
                nextPosts.map(p => [String(p.channelId), p])
            ).values()];

            const createForAllChannels = (title, dateStr) => {
                if (!dateStr || nextPosts.some(p => p.title === title)) return;

                const rawText = textForTitle(title);
                const captions = generateCaptionsForPlatforms(finalName, rawText, event.tags || []);
                const posterDescription = title === 'Thank you'
                    ? ((options.thankYouText || '').trim() || description)
                    : description;

                const imageUrl = poster ? `${base}/api/poster.png?${new URLSearchParams({
                    bg: poster,
                    eyebrow: finalName,
                    headline: title,
                    description: posterDescription,
                    line: fmtDate(dateStr)
                })}` : '';

                for (const ch of eventChannels) {
                    const service = (ch.channelService || '').toLowerCase();
                    const due = withPlatformPostingTime(dateStr, ch.channelService);
                    if (!due || due < new Date()) continue;
                    if (service === 'instagram' && !imageUrl) continue;

                    let text = captions[service]
                        || (service === 'twitter' ? captions.x : null)
                        || captions.facebook;
                    if ((service === 'twitter' || service === 'x') && text.length > 280) {
                        text = text.slice(0, 277) + '...';
                    }

                    nextPosts.push({
                        title,
                        text,
                        channelId: ch.channelId,
                        channelName: ch.channelName,
                        channelService: ch.channelService,
                        bufferPostId: 1,
                        dueAt: due,
                        imageUrl,
                        status: 'scheduled'
                    });
                }
            };

            if (options.announceEnabled) createForAllChannels('Event announcement', options.announceDate);
            if (options.thankYouEnabled) createForAllChannels('Thank you', options.thankYouDate);

            // bifa scoasa => sterge postarile respective de pe toate platformele
            finalPosts = nextPosts.filter(p =>
                !(p.title === 'Event announcement' && !options.announceEnabled) &&
                !(p.title === 'Thank you' && !options.thankYouEnabled)
            );
        }
        if (templateKind === 'multiple-stages') {
            const stages = options.stages || [];
            const eventChannels = [...new Map(
                nextPosts.map(p => [String(p.channelId), p])
            ).values()];

            const stagePosts = [];
            for (const st of stages) {
                const orig = st.origName || st.name;
                const imageUrl = poster ? `${base}/api/poster.png?${new URLSearchParams({
                    bg: poster,
                    eyebrow: finalName,
                    headline: st.name,
                    description,
                    line: fmtDate(st.date)
                })}` : '';

                for (const ch of eventChannels) {
                    const service = (ch.channelService || '').toLowerCase();
                    const due = withPlatformPostingTime(st.date, ch.channelService);
                    const prev = nextPosts.find(p =>
                        p.title === orig && String(p.channelId) === String(ch.channelId));

                    if (prev) {
                        // stage existent (posibil redenumit / mutat)
                        stagePosts.push({ ...prev, title: st.name, dueAt: due || prev.dueAt, imageUrl });
                        continue;
                    }

                    // stage nou => postare noua pe fiecare platforma
                    if (!due || due < new Date()) continue;
                    if (service === 'instagram' && !imageUrl) continue;

                    const rawText = `${st.name} - ${finalName}, ${fmtShort(st.date)}. ${description}`.trim();
                    const captions = generateCaptionsForPlatforms(finalName, rawText, event.tags || []);
                    let text = captions[service]
                        || (service === 'twitter' ? captions.x : null)
                        || captions.facebook;
                    if ((service === 'twitter' || service === 'x') && text.length > 280) {
                        text = text.slice(0, 277) + '...';
                    }

                    stagePosts.push({
                        title: st.name,
                        text,
                        channelId: ch.channelId,
                        channelName: ch.channelName,
                        channelService: ch.channelService,
                        bufferPostId: 1,
                        dueAt: due,
                        imageUrl,
                        status: 'scheduled'
                    });
                }
            }
            finalPosts = stagePosts;
        }

        // to do decomm
        // // 1. sterge din Buffer postarile vechi
        // for (const old of event.posts) await deleteBufferPost(req, old.bufferPostId);

        // // 2. recreeaza-le cu datele noi
        // for (const np of nextPosts) {
        //     if (np.status !== 'scheduled' || !np.dueAt || np.dueAt < new Date()) continue;
        //     const r = await createBufferPost(req, {
        //         text: np.text,
        //         channelId: np.channelId,
        //         service: np.channelService.toLowerCase(),
        //         dueAt: np.dueAt,
        //         imageUrl: np.imageUrl
        //     });
        //     np.bufferPostId = r.id;
        //     np.status = r.id ? 'scheduled' : r.error;
        // }

        event.name = name || event.name;
        event.description = description;
        event.template = templateName;
        event.poster = poster;
        event.dates = new Map(Object.entries(dates || {}));
        event.options = options || {};
        event.posts = finalPosts;

        await event.save();
        // console.log(event);
        res.json({ success: true, event: { id: event._id, name: event.name } });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// sterge intreg event-ul
app.delete('/api/events/:id', async (req, res) => {
    try {
        if (!req.session.buffer || !req.session.userId) {
            return res.status(401).json({ error: 'Not connected' });
        }

        const event = await Event.findOne({ _id: req.params.id, userId: req.session.userId });
        if (!event) return res.status(404).json({ error: 'Event not found' });

        // to do: apelul GraphQL catre API-ul Buffer
        // for (const p of event.posts) await deleteBufferPost(req, p.bufferPostId);

        await event.deleteOne();
        res.json({ success: true, message: 'Event deleted successfully' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// sterge o singura postare dintr-un eveniment
app.delete('/api/events/:id/posts/:postId', async (req, res) => {
    try {
        if (!req.session.buffer || !req.session.userId) {
            return res.status(401).json({ error: 'Not connected' });
        }

        const event = await Event.findOne({ _id: req.params.id, userId: req.session.userId });
        if (!event) return res.status(404).json({ error: 'Event not found' });

        const post = event.posts.id(req.params.postId);
        if (!post) return res.status(404).json({ error: 'Post not found' });

        // to do: apelul GraphQL catre API-ul Buffer (sterge post.bufferPostId)
        // await deleteBufferPost(req, post.bufferPostId);

        post.deleteOne();
        await event.save();
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// sterge toate postarile de pe o platforma
app.delete('/api/events/:id/platform/:service', async (req, res) => {
    try {
        if (!req.session.buffer || !req.session.userId) {
            return res.status(401).json({ error: 'Not connected' });
        }

        const event = await Event.findOne({ _id: req.params.id, userId: req.session.userId });
        if (!event) return res.status(404).json({ error: 'Event not found' });

        const service = req.params.service.toLowerCase();
        const toDelete = event.posts.filter(p => (p.channelService || '').toLowerCase() === service);

        // to do: apelul GraphQL catre API-ul Buffer (sterge fiecare toDelete[i].bufferPostId)
        // for (const p of toDelete) await deleteBufferPost(req, p.bufferPostId);

        event.posts = event.posts.filter(p => (p.channelService || '').toLowerCase() !== service);
        await event.save();
        res.json({ success: true, deleted: toDelete.length });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/events/:id/generate', async (req, res) => {
    try {
        if (!req.session.buffer || !req.session.userId) {
            return res.status(401).json({ error: 'Not connected' });
        }

        const event = await Event.findOne({ _id: req.params.id, userId: req.session.userId });
        if (!event) return res.status(404).json({ error: 'Event not found' });

        const channelIds = (req.body?.channelIds || []).map(String);
        const used = new Set(event.posts.map(p => String(p.channelId)));
        const chans = (req.session.channels || [])
            .filter(c => channelIds.includes(String(c.id)) && !used.has(String(c.id)));
        if (!chans.length) return res.status(400).json({ error: 'No new channels selected' });

        // datele evenimentului, ca in celelalte rute
        const tplKey = Object.keys(eventTemplates).find(k => eventTemplates[k].name === event.template);
        const t = eventTemplates[tplKey];
        if (!t) return res.status(400).json({ error: 'Unknown event template' });

        const name = event.name;
        const description = event.description || '';
        const tags = event.tags || [];
        const poster = event.poster || '';
        const dates = event.dates ? Object.fromEntries(event.dates.entries()) : {};
        const options = event.options || {};

        const templatePosts = typeof t.buildPosts === 'function'
            ? t.buildPosts({ name, description, dates, options })
            : t.posts;
        const tplByTitle = new Map((templatePosts || []).map(p => [p.title, p]));

        // to do
        // const base = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
        const base = `${req.protocol}://${req.get('host')}`;
        const fmtDate = d => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });

        // surse: cate una pentru fiecare (titlu + data), le folosim doar pentru titlu si data
        const sources = new Map();
        for (const p of event.posts) {
            const key = `${p.title}|${toIsoDate(p.dueAt)}`;
            if (!sources.has(key)) sources.set(key, p);
        }
        if (!sources.size) return res.status(400).json({ error: 'No existing posts to base on' });

        const added = [];
        const skipped = [];

        try {
            for (const src of sources.values()) {
                const tp = tplByTitle.get(src.title);
                const rawText = tp
                    ? (typeof tp.text === 'function' ? tp.text({ name, description, dates }) : tp.text)
                    : (src.text || '');
                const captions = generateCaptionsForPlatforms(name, rawText, tags);

                const posterDescription = (t.kind === 'single-stage' && src.title === 'Thank you')
                    ? ((options.thankYouText || '').trim() || description)
                    : description;

                const imageUrl = poster ? `${base}/api/poster.png?${new URLSearchParams({
                    bg: poster,
                    eyebrow: name,
                    headline: src.title,
                    description: posterDescription,
                    line: tp?.lineDate
                        ? fmtDate(tp.lineDate)
                        : (tp && tp.days <= 0 && dates[tp.at] ? fmtDate(dates[tp.at]) : '')
                })}` : null;

                for (const ch of chans) {
                    const service = ch.service.toLowerCase();
                    const due = withPlatformPostingTime(src.dueAt, ch.service);

                    if (!due || Number.isNaN(due.getTime()) || due < new Date()) {
                        skipped.push(`${src.title} (${ch.name}: date passed)`);
                        continue;
                    }
                    if (service === 'instagram' && !imageUrl) {
                        skipped.push(`${src.title} (${ch.name}: needs a poster)`);
                        continue;
                    }
                    // to do
                    // if (service === 'instagram' && /localhost|127\.0\.0\.1/i.test(imageUrl)) {
                    //     skipped.push(`${src.title} (${ch.name}: image URL is not public)`);
                    //     continue;
                    // }

                    let text = captions[service]
                        || (service === 'twitter' ? captions.x : null)
                        || captions.facebook;
                    if ((service === 'twitter' || service === 'x') && text.length > 280) {
                        text = text.slice(0, 277) + '...';
                    }

                    // to do
                    // const r = await createBufferPost(req, {
                    //     text,
                    //     channelId: ch.id,
                    //     service,
                    //     dueAt: due,
                    //     imageUrl
                    // });

                    // if (!r.id) {
                    //     skipped.push(`${src.title} (${ch.name}: ${r.error || 'Buffer error'})`);
                    //     continue;
                    // }

                    added.push({
                        title: src.title,
                        text,
                        channelId: ch.id,
                        channelName: ch.name,
                        channelService: ch.service,
                        // bufferPostId: r.id,
                        bufferPostId: 1,
                        dueAt: due,
                        imageUrl: imageUrl || '',
                        status: 'scheduled'
                    });
                }
            }
        } catch (err) {
            if (added.length) {
                event.posts.push(...added);
                await event.save().catch(console.error);
            }
            return res.status(err.status || 500).json({
                error: err.message,
                added: added.length,
                skipped
            });
        }

        if (added.length) {
            event.posts.push(...added);
            event.channelIds = [...new Set([
                ...(event.channelIds || []),
                ...added.map(a => a.channelId)
            ])];
            await event.save();
        }

        res.json({ success: true, added: added.length, skipped });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// const { GoogleGenAI } = require('@google/genai');
// const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function generateCaptionsForPlatformsWithGemini(eventName, rawPostText, description, tags) {
    try {
        const prompt = `You are an expert social media manager. Based on the event name "${eventName}", event description "${description}", the original post text "${rawPostText}", and tags ${JSON.stringify(tags)}, generate tailored social media captions in English for each platform:
        1. LinkedIn (professional, career/education-oriented, include hashtags)
        2. X (short, concise, under 280 characters, with relevant hashtags)
        3. Instagram (visually engaging, uses emojis, plenty of hashtags)
        4. Facebook (informative, friendly, community-oriented, include hashtags)

        Return STRICTLY a valid JSON object (no markdown formatting, no extra text) with the following structure:
        {"linkedin": "...", "x": "...", "instagram": "...", "facebook": "..."}`;

        const response = await ai.models.generateContent({
            model: 'gemini-3.8-flash',
            contents: prompt,
            config: { responseMimeType: 'application/json' }
        });

        return JSON.parse(response.text);
    } catch (err) {
        console.error('Gemini Error, falling back to default text:', err);
        const fallbackTags = tags.map(t => '#' + t.replace(/\W/g, '')).join(' ');
        const baseText = `${rawPostText}\n\n${fallbackTags}`.trim();
        return {
            linkedin: baseText,
            x: baseText,
            instagram: baseText,
            facebook: baseText
        };
    }
}

function generateCaptionsForPlatforms(eventName, rawPostText, tags) {
    const formattedTags = tags.map(t => '#' + t.replace(/\W/g, '')).join(' ');
    const baseText = `${rawPostText}\n\n${formattedTags}`.trim();

    return {
        linkedin: `Excited to announce ${eventName}!\n\n${rawPostText}\n\n${formattedTags} #professional #networking`,
        x: baseText,
        instagram: `${rawPostText}\n\n${formattedTags} #event #community`,
        facebook: `We are happy to share updates about ${eventName}.\n\n${baseText}`
    };
}

const PLATFORM_POSTING_TIME_UTC = {
    twitter: [14, 0],
    x: [14, 0],
    linkedin: [11, 30],
    instagram: [18, 0],
    facebook: [18, 0]
};

function toIsoDate(value) {
    if (!value) return '';
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return '';
    return parsed.toISOString().slice(0, 10);
}

function withPlatformPostingTime(dateLike, channelService) {
    const datePart = toIsoDate(dateLike);
    if (!datePart) return undefined;

    const service = String(channelService || '').toLowerCase();
    const [hour, minute] = PLATFORM_POSTING_TIME_UTC[service] || [12, 0];
    const hh = String(hour).padStart(2, '0');
    const mm = String(minute).padStart(2, '0');

    return new Date(`${datePart}T${hh}:${mm}:00.000Z`);
}

app.post('/api/events', async (req, res) => {
    const {
        name,
        description = '',
        template,
        dates = {},
        options = {},
        channels = [],
        tags = [],
        poster = ''
    } = req.body;

    const channelIds = channels.map(id => String(id).split('|')[0]);

    if (!req.session.buffer || !req.session.userId) {
        return res.status(401).json({ error: 'Not connected' });
    }
    if (poster && !Object.hasOwn(posterTemplates, poster)) {
        return res.status(400).json({ error: 'Unknown poster design' });
    }
    
    const t = eventTemplates[template];
    // console.log(t);
    const chans = (req.session.channels || []).filter(c => channelIds.includes(c.id));
    // console.log(chans, channelIds);
    if (!t || !chans.length) return res.status(400).json({ error: 'Pick a template and a channel' });

    const results = [];
    const base = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
    const fmtDate = d => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });
    const hasInstagram = chans.some(ch => ch.service === 'instagram');

    if (poster && hasInstagram && /localhost|127\.0\.0\.1/i.test(base)) {
        return res.status(400).json({
            error: 'Instagram posts with images require a public image URL. Set PUBLIC_BASE_URL to a public HTTPS domain (for example via a tunnel).'
        });
    }

    const saveEvent = () => Event.create({
        userId: req.session.userId,
        name, description, template: t.name, poster, tags, channelIds, dates, options,
        posts: results.filter(x => x.channelId).map(x => ({
            title: x.title, text: x.text, channelId: x.channelId, channelName: x.channel,
            channelService: x.channelService,
            bufferPostId: x.bufferPostId, dueAt: x.dueAt, imageUrl: x.image, status: x.status
        }))
    });

    try {
        const templatePosts = typeof t.buildPosts === 'function'
            ? t.buildPosts({ name, description, dates, options })
            : t.posts;

        for (const p of templatePosts) {
            let baseDueDate = p.dueDate || dates[p.at] || '';
            if (!p.dueDate && baseDueDate) {
                const shifted = new Date(`${baseDueDate}T12:00:00.000Z`);
                shifted.setUTCDate(shifted.getUTCDate() + 30);
                baseDueDate = shifted.toISOString().slice(0, 10);
            }

            if (!baseDueDate) {
                results.push({ title: p.title, status: 'skipped (missing date)' });
                continue;
            }

            const rawPostText = typeof p.text === 'function' ? p.text({ name, description, dates }) : p.text;
            const platformCaptions = await generateCaptionsForPlatforms(name, rawPostText, tags);

            for (const ch of chans) {
                const serviceKey = ch.service.toLowerCase();
                let text = platformCaptions[serviceKey] || platformCaptions.facebook || rawPostText;
                const due = withPlatformPostingTime(baseDueDate, ch.service);
                if (!due || Number.isNaN(due.getTime()) || due < new Date()) {
                    results.push({ title: p.title, channel: ch.name, status: 'skipped (date passed)' });
                    continue;
                }
                const posterDescription = (t.kind === 'single-stage' && p.title === 'Thank you')
                    ? ((options.thankYouText || '').trim() || description)
                    : description;

                const imageUrl = poster ? `${base}/api/poster.png?${new URLSearchParams({
                    bg: poster,
                    eyebrow: name,
                    headline: p.title,
                    description: posterDescription,
                    line: p.lineDate ? fmtDate(p.lineDate) : (p.days <= 0 ? fmtDate(dates[p.at]) : '')
                })}` : null;

                // to do - decomenteaza
                // const r = await createBufferPost(req, {
                //     text, channelId: ch.id, service: ch.service, dueAt: due, imageUrl
                // });

                // results.push({
                //     title: p.title, text, channel: ch.name, channelId: ch.id, channelService: ch.service,
                //     bufferPostId: r.id,
                //     dueAt: due, image: imageUrl,
                //     status: r.id ? 'scheduled' : r.error
                // });

                results.push({ title: p.title, text, channel: ch.name, channelId: ch.id, channelService: ch.service, 
                    bufferPostId: 1,
                    // bufferPostId: r.post?.id, 
                    dueAt: due, image: imageUrl, 
                    status: 'scheduled'
                    // status: r.post ? 'scheduled' : r.message 
                });
            }
        }

        await saveEvent();
        res.json({ results });
    } catch (e) {
        console.error(e.stack);
        if (results.some(x => x.channelId)) await saveEvent().catch(console.error);
        res.status(e.status || 500).json({ error: e.message, results });
    }
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

async function renderPoster({ bg, eyebrow, headline, description, line, debug }) {
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
        { text: line, k: 0.7, extraSpace: 2.8 }, 
        { text: description, k: 0.6, widthFactor: 0.75 }
    ].filter(b => b.text);

    // micsoreaza fontul
    let S = img.width * 0.07, layout = [], h = 0;
    for (; S >= 14; S -= 2) {
        layout = []; h = 0;
        for (const b of blocks) {
            const size = S * b.k;
            ctx.font = `${size}px ${family}`;
            const currentW = z.w * (b.widthFactor || 1.0);
            const lines = wrap(ctx, b.text, currentW);
            const lh = size * 1.2;
            
            const blockSpacing = size * 0.5 * (b.extraSpace || 1);
            layout.push({ lines, size, lh, blockSpacing });
            h += lines.length * lh + blockSpacing;
        }
        if (h <= z.h) break;
    }

    let y = z.y + (z.h - h) / 2;
    for (const l of layout) {
        ctx.font = `${l.size}px ${family}`;
        for (const t of l.lines) { 
            ctx.fillText(t, z.x + z.w / 2, y); 
            y += l.lh; 
        }
        y += l.blockSpacing;
    }
    return canvas.toBuffer('image/png');
}

// buffer descarca imaginea de aici
app.get('/api/poster.png', async (req, res) => {
    try {
        const { bg, eyebrow = '', headline = '', description = '', line = '', debug } = req.query;
        if (!Object.hasOwn(posterTemplates, bg)) return res.status(400).send('Unknown design');
        const png = await renderPoster({
            bg,
            eyebrow: eyebrow.slice(0, 80),
            headline: headline.slice(0, 80),
            description,
            line: line.slice(0, 120),
            debug: !!debug
        });
        res.type('png').set('Cache-Control', 'public, max-age=3600').send(png);
    } catch (e) { res.status(500).send(e.message); }
});



function start() {
    if (process.env.LOCAL_HTTPS === '1') {
        https.createServer({
            key: fs.readFileSync('localhost-key.pem'),
            cert: fs.readFileSync('localhost.pem')
        }, app).listen(PORT, () => console.log(`HTTPS local pe https://localhost:${PORT}`));
    } else {
        app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));
    }
}

mongoose.connect(process.env.MONGODB_URI)
    .then(() => { console.log('MongoDB connected'); start(); })
    .catch(err => { console.error('MongoDB connection failed:', err.message); process.exit(1); });