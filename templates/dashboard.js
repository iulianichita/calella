const $ = id => document.getElementById(id);
let data;

async function init() {
    const r = await fetch('/api/me');
    // if (!r.ok) return (location.href = 'home.html');
    data = await r.json();

    const name = data.email.split('@')[0];
    $('greeting').textContent = `Hello, ${name}!`;
    $('today').textContent = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

    $('stat-channels').textContent = data.channels.length;
    $('stat-events').textContent = data.events.length;
    $('stat-posts').textContent = data.events.reduce((s, e) => s + e.posts, 0);

    $('channels-list').innerHTML = data.channels.map(c => `
        <div class="card chan"><div class="chan-dot">${c.service[0].toUpperCase()}</div>
        <div><h3 style="margin:0;font-size:16px">${c.name}</h3><p class="label">${c.service}</p></div></div>`).join('')
        || '<p class="subtitle">No channels yet. Connect one in Buffer.</p>';

    $('events-list').innerHTML = data.events.map(e => `
        <article class="card"><p class="label">${e.template}</p><h3>${e.name}</h3>
        <p class="card-text">${e.posts} posts scheduled</p></article>`).join('')
        || '<p class="subtitle">No events yet. Start one below.</p>';

    $('channel-checks').innerHTML = data.channels.map(c =>
        `<label><input type="checkbox" value="${c.id}" checked> ${c.name} (${c.service})</label>`).join('');

    $('template').innerHTML = Object.entries(data.templates)
        .map(([k, t]) => `<option value="${k}">${t.name}</option>`).join('');
    renderDates();
    }

    function renderDates() {
    const fields = data.templates[$('template').value].fields;
    $('date-fields').innerHTML = Object.entries(fields).map(([k, label]) =>
        `<label>${label}<input type="date" name="date_${k}" required></label>`).join('');
    }
    $('template').addEventListener('change', renderDates);

    $('event-form').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target;
    const fields = data.templates[f.template.value].fields;
    const dates = Object.fromEntries(Object.keys(fields).map(k => [k, f[`date_${k}`].value]));

    $('submit-btn').disabled = true;
    $('submit-btn').textContent = 'Scheduling…';

    const r = await fetch('/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
        name: f.name.value,
        description: f.description.value,
        template: f.template.value,
        dates,
        channelIds: [...document.querySelectorAll('#channel-checks input:checked')].map(i => i.value),
        tags: f.tags.value.split(',').map(t => t.trim()).filter(Boolean)
        })
    });
    const out = await r.json();

    const box = $('results');
    box.hidden = false;
    box.innerHTML = `<h3>${r.ok ? 'Done' : 'Something went wrong: ' + out.error}</h3><ul>` +
        (out.results || []).map(x => `<li><b>${x.title}</b>${x.channel ? ' · ' + x.channel : ''}
        ${x.dueAt ? ' · ' + new Date(x.dueAt).toLocaleDateString('en-GB') : ''}
        · <span class="${x.status === 'scheduled' ? 'ok' : 'warn'}">${x.status}</span></li>`).join('') + '</ul>';

    $('submit-btn').disabled = false;
    $('submit-btn').textContent = 'Create and schedule everything';
    if (r.ok) init();
});

init();