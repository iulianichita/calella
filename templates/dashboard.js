const $ = id => document.getElementById(id);
let data;

const nav = document.querySelector('.nav');

function syncNavState() {
    if (!nav) return;
    nav.classList.toggle('is-scrolled', window.scrollY > 8);
}

window.addEventListener('scroll', syncNavState, { passive: true });
syncNavState();

async function init() {
    const r = await fetch('/api/me');
    // if (!r.ok) return (location.href = '/home');
    data = await r.json();

    const name = data.email.split('@')[0];
    // const name = data.name;
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
    renderTemplateFields();

    $('poster-picker').innerHTML =
        `<label class="poster-opt"><input type="radio" name="poster" value=""><div class="poster-none">None</div><span>Text only</span></label>` +
        Object.entries(data.posters).map(([k, p], i) => `
            <label class="poster-opt">
                <input type="radio" name="poster" value="${k}" ${i === 0 ? 'checked' : ''}>
                <img src="${p.url}" alt="${p.name}"><span>${p.name}</span>
            </label>`).join('');
    updatePreview();

    $('poster-picker').addEventListener('change', updatePreview);
    $('event-form').elements['name'].addEventListener('input', updatePreview);
    $('template-fields').addEventListener('input', updatePreview);
    $('template-fields').addEventListener('change', updatePreview);

    function currentTemplate() {
        return data.templates[$('template').value];
    }

    function syncSingleStageControls() {
        const announceEnabled = $('single-announce-enabled');
        const announceDate = $('single-announce-date');
        const thankYouEnabled = $('single-thankyou-enabled');
        const thankYouDate = $('single-thankyou-date');
        const fallbackNote = $('single-thankyou-fallback');

        if (!announceEnabled || !announceDate || !thankYouEnabled || !thankYouDate || !fallbackNote) return;

        announceDate.disabled = !announceEnabled.checked;
        if (!announceEnabled.checked) announceDate.value = '';

        thankYouDate.disabled = !thankYouEnabled.checked;
        fallbackNote.hidden = !thankYouEnabled.checked || !!thankYouDate.value;
    }

    function addStageRow(container, index) {
        const row = document.createElement('div');
        row.className = 'card';
        row.dataset.stageRow = '1';
        row.innerHTML = `
            <label>Stage name
                <input name="stage_name_${index}" placeholder="Stage ${index}" required>
            </label>
            <label>Stage day
                <input type="date" name="stage_date_${index}" required>
            </label>
            <br>
            <button type="button" class="btn btn-small stage-remove">Remove</button>
        `;
        container.appendChild(row);
    }

    function renderTemplateFields() {
        const tpl = currentTemplate();
        const host = $('template-fields');
        const hint = $('template-hint');

        if (tpl.kind === 'single-stage') {
            hint.textContent = 'Single-stage flow: event day, optional advance announcement, optional thank-you post.';
            host.className = 'grid grid-2';
            host.innerHTML = `
                <label>Event day
                    <input type="date" name="date_eventDay" required>
                </label>
                <label>
                    <input type="checkbox" id="single-announce-enabled" name="single_announceEnabled">
                    Publish an advance announcement
                </label>
                <label>Advance post date
                    <input type="date" id="single-announce-date" name="single_announceDate" disabled>
                </label>
                <label>
                    <input type="checkbox" id="single-thankyou-enabled" name="single_thankYouEnabled">
                    Publish a thank-you post
                </label>
                <label>Thank-you message
                    <textarea name="single_thankYouText" rows="3" placeholder="Thank you for joining us!"></textarea>
                </label>
                <label>Thank-you date (optional)
                    <input type="date" id="single-thankyou-date" name="single_thankYouDate" disabled>
                    <small id="single-thankyou-fallback" class="subtitle" hidden>If this date is empty, the thank-you post will be published 7 days after event day.</small>
                </label>
            `;
            $('single-announce-enabled').addEventListener('change', syncSingleStageControls);
            $('single-thankyou-enabled').addEventListener('change', syncSingleStageControls);
            $('single-thankyou-date').addEventListener('input', syncSingleStageControls);
            syncSingleStageControls();
            return;
        }

        if (tpl.kind === 'multiple-stages') {
            hint.textContent = 'Multiple stages flow: start with 2 stages and add as many extra stages as needed.';
            host.className = 'grid';
            host.innerHTML = `
                <div id="stages-list" class="grid grid-2"></div>
                <button type="button" class="btn" id="add-stage">Add stage</button>
            `;

            const list = $('stages-list');
            addStageRow(list, 1);
            addStageRow(list, 2);

            $('add-stage').addEventListener('click', () => {
                const nextIndex = list.querySelectorAll('[data-stage-row]').length + 1;
                addStageRow(list, nextIndex);
            });

            list.addEventListener('click', e => {
                const btn = e.target.closest('.stage-remove');
                if (!btn) return;
                const rows = list.querySelectorAll('[data-stage-row]');
                if (rows.length <= 2) return;
                btn.closest('[data-stage-row]')?.remove();
            });
            return;
        }

        hint.textContent = '';
        host.className = 'grid grid-3';
        host.innerHTML = Object.entries(tpl.fields || {}).map(([k, label]) =>
            `<label>${label}<input type="date" name="date_${k}" required></label>`).join('');
    }

    function collectTemplatePayload(form) {
        const tpl = currentTemplate();
        const dates = {};
        const options = {};

        if (tpl.kind === 'single-stage') {
            dates.eventDay = form['date_eventDay'].value;
            options.announceEnabled = form['single_announceEnabled'].checked;
            options.announceDate = form['single_announceDate'].value;
            options.thankYouEnabled = form['single_thankYouEnabled'].checked;
            options.thankYouDate = form['single_thankYouDate'].value;
            options.thankYouText = form['single_thankYouText'].value;

            if (!dates.eventDay) return { error: 'Please choose an event day.' };
            if (options.announceEnabled && !options.announceDate) {
                return { error: 'Please choose a date for the advance announcement.' };
            }
            return { dates, options };
        }

        if (tpl.kind === 'multiple-stages') {
            const rows = [...document.querySelectorAll('#stages-list [data-stage-row]')];
            const stages = rows.map(row => {
                const name = row.querySelector('input[name^="stage_name_"]')?.value.trim();
                const date = row.querySelector('input[name^="stage_date_"]')?.value;
                return { name, date };
            });

            if (stages.length < 2) return { error: 'Please keep at least 2 stages.' };
            if (stages.some(s => !s.name || !s.date)) {
                return { error: 'Please complete all stage names and dates.' };
            }

            options.stages = stages;
            return { dates, options };
        }

        const fields = tpl.fields || {};
        Object.keys(fields).forEach(k => {
            dates[k] = form[`date_${k}`].value;
        });
        return { dates, options };
    }

    $('template').addEventListener('change', () => {
        renderTemplateFields();
        updatePreview();
    });

    $('event-form').addEventListener('submit', async e => {
        e.preventDefault();
        const f = e.target;
        const payload = collectTemplatePayload(f);
        if (payload.error) {
            alert(payload.error);
            return;
        }

        $('submit-btn').disabled = true;
        $('submit-btn').textContent = 'Scheduling...';

        try {
            const r = await fetch('/api/events', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: f.name.value,
                    description: f.description.value,
                    template: f.template.value,
                    dates: payload.dates,
                    options: payload.options,
                    channelIds: [...document.querySelectorAll('#channel-checks input:checked')].map(i => i.value),
                    tags: f.tags.value.split(',').map(t => t.trim()).filter(Boolean),
                    poster: f.querySelector('input[name="poster"]:checked')?.value || '',
                })
            });

            let out;
            const contentType = r.headers.get('content-type') || '';
            if (contentType.includes('application/json')) {
                out = await r.json();
            } else {
                const text = await r.text();
                out = { error: text || 'Unexpected server response', results: [] };
            }

            const box = $('results');
            box.hidden = false;
            box.innerHTML = `<h3>${r.ok ? 'Done' : 'Something went wrong: ' + out.error}</h3><ul>` +
                (out.results || []).map(x => `<li><b>${x.title}</b>${x.channel ? ' · ' + x.channel : ''}
                ${x.dueAt ? ' · ' + new Date(x.dueAt).toLocaleDateString('en-GB') : ''}
                · <span class="${x.status === 'scheduled' ? 'ok' : 'warn'}">${x.status}</span>${x.image ? `<br><a href="${x.image}" target="_blank"><img class="res-img" src="${x.image}" alt=""></a>` : ''}</li>`).join('') + '</ul>';

            if (r.ok) init();
        } catch (err) {
            const box = $('results');
            box.hidden = false;
            box.innerHTML = `<h3>Something went wrong: ${err.message || 'Network error'}</h3>`;
        } finally {
            $('submit-btn').disabled = false;
            $('submit-btn').textContent = 'Create and schedule everything';
        }
    });
}

let previewTimer;
function updatePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
        const poster = document.querySelector('input[name="poster"]:checked')?.value;
        const box = $('poster-preview');
        if (!poster) { box.hidden = true; return; }

        const tpl = data?.templates?.[$('template').value];
        let headline = 'Event update';
        let line = '';

        if (tpl?.kind === 'single-stage') {
            headline = 'Event day';
            line = $('event-form').elements['date_eventDay']?.value || '';
        } else if (tpl?.kind === 'multiple-stages') {
            headline = document.querySelector('input[name^="stage_name_"]')?.value || 'Stage 1';
            line = document.querySelector('input[name^="stage_date_"]')?.value || '';
        }

        const q = new URLSearchParams({
            bg: poster,
            eyebrow: $('event-form').elements['name'].value || 'Event name',
            headline,
            line
        });
        box.src = `/api/poster.png?${q}`;
        box.hidden = false;
    }, 300);
}
init();