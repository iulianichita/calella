const $ = id => document.getElementById(id);
let data;
let selectedEventId = null;
let modalPosts = [];
let modalPlatform = '';
let modalIndex = 0;
let modalListenersBound = false;
let editEventState = null;
let modalEditMode = false;

const nav = document.querySelector('.nav');

function syncNavState() {
    if (!nav) return;
    nav.classList.toggle('is-scrolled', window.scrollY > 8);
}

window.addEventListener('scroll', syncNavState, { passive: true });
syncNavState();

const modalEditToggle = $('event-modal-edit-toggle');
modalEditToggle?.addEventListener('click', () => {
    if (!editEventState) return;
    modalEditMode = !modalEditMode;
    if (modalEditMode) renderEditPanel();
    else renderModalSlide();
    syncModalEditorVisibility();
});

const modalDelToggle = $('event-modal-del-toggle');
modalDelToggle?.addEventListener('click', async () => {
    syncModalEditorVisibility();
    const eventId = selectedEventId; 
    const userInput = prompt('Please type DELETE to PERMANENTLY delete this event:');

    if (userInput === 'DELETE') {
        try {
            const response = await fetch(`/api/events/${eventId}`, {
                method: 'DELETE'
            });

            if (!response.ok) {
                throw new Error('Deleting error');
            }

            // alert('Evenimentul a fost sters cu succes!');
            window.location.reload(); 

        } catch (err) {
            console.error(err);
        }
    } else {
        console.log('DELETE operation canceled.');
        alert('DELETE operation canceled.');
    }
});

function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function serviceName(service) {
    if (!service) return 'Platform';
    if (service === 'twitter') return 'X / Twitter';
    return service.charAt(0).toUpperCase() + service.slice(1);
}

function getPostKey(post) {
    if (!post) return '';
    return String(post.id || post._id || `${post.channelService || 'unknown'}-${post.channelName || 'channel'}-${post.title || 'untitled'}-${post.dueAt || ''}`);
}

function syncModalEditorVisibility() {
    const body = $('event-modal-body');
    const editor = $('event-modal-editor');
    const toggle = $('event-modal-edit-toggle');

    if (body) body.hidden = modalEditMode;
    if (editor) editor.hidden = !modalEditMode;
    if (toggle) {
        toggle.textContent = modalEditMode ? 'Preview' : 'Edit';
        toggle.setAttribute('aria-pressed', String(modalEditMode));
    }
}

function closeEventModal() {
    $('event-modal').hidden = true;
    modalPosts = [];
    modalPlatform = '';
    modalIndex = 0;
    modalEditMode = false;
    editEventState = null;
    document.body.style.overflow = '';
    syncModalEditorVisibility();
}

function getGroupedModalPosts(posts = modalPosts) {
    const grouped = new Map();

    for (const post of posts) {
        const service = (post?.channelService || 'unknown').toLowerCase();
        if (!grouped.has(service)) {
            grouped.set(service, {
                key: service,
                label: serviceName(post?.channelService || service),
                posts: []
            });
        }
        grouped.get(service).posts.push(post);
    }

    return [...grouped.values()];
}

function renderPlatformTabs() {
    const container = $('event-modal-platforms');
    const groups = getGroupedModalPosts(editEventState?.posts || modalPosts);

    if (!container || !groups.length) {
        if (container) container.innerHTML = '';
        return;
    }

    const active = groups.some(group => group.key === modalPlatform) ? modalPlatform : groups[0].key;
    modalPlatform = active;

    container.innerHTML = groups.map(group => `
        <button
            type="button"
            class="event-modal-platform ${group.key === active ? 'active' : ''}"
            data-platform="${group.key}"
            aria-pressed="${group.key === active ? 'true' : 'false'}"
        >${group.label}</button>
    `).join('');

    container.querySelectorAll('[data-platform]').forEach(button => {
        button.addEventListener('click', () => {
            modalPlatform = button.dataset.platform;
            modalIndex = 0;
            renderPlatformTabs();
            renderModalSlide();
        });
    });
}

function updateCaptionForCurrentPost(value) {
    if (!editEventState?.posts?.length) return;
    const groups = getGroupedModalPosts(editEventState.posts);
    const activeGroup = groups.find(group => group.key === modalPlatform) || groups[0];
    if (!activeGroup) return;
    const post = activeGroup.posts[modalIndex] || activeGroup.posts[0];
    if (!post) return;
    const key = getPostKey(post);
    const target = editEventState.posts.find(item => getPostKey(item) === key);
    if (target) target.text = value;
}

function renderModalSlide() {
    const slide = $('modal-slide');
    const counter = $('event-modal-counter');
    const prev = $('modal-prev');
    const next = $('modal-next');
    const groups = getGroupedModalPosts(editEventState?.posts || modalPosts);

    if (modalEditMode) {
        if (slide) slide.innerHTML = '';
        if (counter) counter.textContent = '';
        if (prev) prev.disabled = true;
        if (next) next.disabled = true;
        return;
    }

    if (!groups.length) {
        slide.innerHTML = '<p class="subtitle">No post details available.</p>';
        counter.textContent = '';
        prev.disabled = true;
        next.disabled = true;
        return;
    }

    const activeGroup = groups.find(group => group.key === modalPlatform) || groups[0];
    modalPlatform = activeGroup.key;

    const posts = activeGroup.posts;
    const post = posts[modalIndex] || posts[0];

    if (!post) {
        slide.innerHTML = '<p class="subtitle">No post details available.</p>';
        counter.textContent = '';
        prev.disabled = true;
        next.disabled = true;
        return;
    }

    const channel = escapeHtml(post.channelName || 'Unknown channel');
    const service = (post.channelService || '').toLowerCase();
    const due = post.dueAt ? new Date(post.dueAt).toLocaleDateString('en-GB') : 'No date';
    const imageMarkup = post.imageUrl
        ? `<img class="platform-preview-image" src="${escapeHtml(post.imageUrl)}" alt="${escapeHtml(post.title || 'Post preview image')}">`
        : '<div class="platform-preview-image placeholder">No image</div>';
    const textareaValue = String(post.text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    counter.textContent = `${activeGroup.label} · Post ${modalIndex + 1} of ${posts.length}`;
    prev.disabled = modalIndex <= 0;
    next.disabled = modalIndex >= posts.length - 1;

    slide.innerHTML = `
        <article class="platform-post-card platform-${service || 'generic'}">
            <div class="platform-post-visual">
                ${imageMarkup}
            </div>
            <div class="platform-post-content">
                <div class="platform-post-meta">
                    <span>${escapeHtml(activeGroup.label)}</span>
                    <span>${channel}</span>
                </div>
                <h4>${escapeHtml(post.title || 'Untitled post')}</h4>
                <label class="platform-post-caption-label">Caption</label>
                <textarea class="platform-post-caption-input" data-post-key="${escapeHtml(getPostKey(post))}">${textareaValue}</textarea>
                <div class="platform-post-foot">
                    <span>${due}</span>
                    <span>${escapeHtml(post.status || 'unknown')}</span>
                </div>
            </div>
        </article>
    `;

    const captionInput = slide.querySelector('.platform-post-caption-input');
    if (captionInput) {
        captionInput.addEventListener('input', e => {
            const target = (editEventState?.posts || []).find(item => getPostKey(item) === e.target.dataset.postKey);
            if (target) target.text = e.target.value;
        });
    }

    renderPlatformTabs();
}

function backToPreview() {
    modalEditMode = false;
    modalIndex = 0;
    const nextGroups = getGroupedModalPosts(editEventState.posts);
    modalPlatform = nextGroups[0]?.key || '';
    renderPlatformTabs();
    renderModalSlide();
    renderEditPanel(); 
    syncModalEditorVisibility();
}

async function reloadAfterDelete() {
    const details = await loadEventDetails(selectedEventId);
    editEventState = details;
    modalPosts = Array.isArray(details.posts) ? details.posts.filter(Boolean) : [];
    modalIndex = 0;
    modalPlatform = getGroupedModalPosts(modalPosts)[0]?.key || '';

    if (!modalPosts.length) {
        // nu mai sunt postari: inchide modalul si reimprospateaza dashboard-ul
        init();
        closeEventModal();
        return;
    }

    renderPlatformTabs();
    renderModalSlide();
    renderEditPanel();
    backToPreview();
    init();
}

function renderEditPanel() {
    const form = $('event-edit-form');
    if (!form || !editEventState) return;

    const templates = Object.entries(data.templates || {});
    const posterOptions = Object.entries(data.posters || {});
    const templateKey = (editEventState.template && data.templates[editEventState.template]) ? editEventState.template : templates[0]?.[0] || '';
    const selectedPoster = editEventState.poster || '';
    const tpl = data.templates[templateKey] || { kind: 'single-stage' };
    editEventState.template = templateKey;

    let templateFieldsMarkup = '';
    if (tpl.kind === 'single-stage') {
            const postTitles = (editEventState.posts || []).map(p => p.title);
            const hasAnnouncePost = postTitles.includes('Event announcement');
            const hasThankYouPost = postTitles.includes('Thank you');

            const announceEnabled = hasAnnouncePost;
            const thankYouEnabled = hasThankYouPost;

            const announceMarkup = hasAnnouncePost ? `
                <div class="conditional-row">
                    <label class="checkbox-label">
                        <input type="checkbox" name="edit_announceEnabled" checked>
                        <span>Publish announcement</span>
                    </label>
                    <div class="conditional-reveal">
                        <label>Announcement date
                            <input type="date" name="edit_announceDate" value="${editEventState.options?.announceDate || ''}">
                        </label>
                    </div>
                </div>
            ` : '';

            const thankYouMarkup = hasThankYouPost ? `
                <div class="conditional-row">
                    <label class="checkbox-label">
                        <input type="checkbox" name="edit_thankYouEnabled" checked>
                        <span>Publish thank-you post</span>
                    </label>
                    <div class="conditional-reveal">
                        <label>Thank-you date
                            <input type="date" name="edit_thankYouDate" value="${editEventState.options?.thankYouDate || ''}">
                        </label>
                        <label>Thank-you caption
                            <textarea name="edit_thankYouText">${escapeHtml(editEventState.options?.thankYouText || '')}</textarea>
                        </label>
                    </div>
                </div>
            ` : '';

            templateFieldsMarkup = `
                <label>Event day
                    <input type="date" name="edit_eventDay" value="${editEventState.dates?.eventDay || ''}" required>
                </label>
                ${announceMarkup}
                ${thankYouMarkup}
            `;
        } else if (tpl.kind === 'multiple-stages') {
        const stages = Array.isArray(editEventState.options?.stages) && editEventState.options.stages.length ? editEventState.options.stages : [{ name: '', date: '' }, { name: '', date: '' }];
        templateFieldsMarkup = `
            <div class="event-edit-row">
                <strong>Stages</strong>
                <button type="button" class="btn btn-small" id="edit-stage-add">Add stage</button>
            </div>
            <div id="edit-stages-list">
                ${stages.map((stage, index) => `
                    <div class="conditional-row" data-edit-stage-row="${index}">
                        <label>Stage name
                            <input type="text" name="edit_stage_name_${index}" value="${escapeHtml(stage.name || '')}">
                        </label>
                        <label>Stage day
                            <input type="date" name="edit_stage_date_${index}" value="${stage.date || ''}">
                        </label>
                        <button type="button" class="btn btn-small" data-edit-stage-remove="${index}">Remove</button>
                    </div>
                `).join('')}
            </div>
        `;
    }

    form.innerHTML = `
            <label>Event title
                <input type="text" name="edit_name" value="${escapeHtml(editEventState.name || '')}" required>
            </label>
            <label>Poster description (captions will be auto-generated)
                <textarea name="edit_description" rows="4">${escapeHtml(editEventState.description || '')}</textarea>
            </label>
            <fieldset>
                <legend>Poster design</legend>
                <div class="poster-picker">
                    <label class="poster-opt">
                        <input type="radio" name="edit_poster" value="" ${selectedPoster === '' ? 'checked' : ''}>
                        <div class="poster-none">None</div>
                        <span>Text only</span>
                    </label>
                    ${posterOptions.map(([k, p]) => `
                        <label class="poster-opt">
                            <input type="radio" name="edit_poster" value="${k}" ${selectedPoster === k ? 'checked' : ''}>
                            <img src="${p.url}" alt="${escapeHtml(p.name)}">
                            <span>${escapeHtml(p.name)}</span>
                        </label>
                    `).join('')}
                </div>
            </fieldset>
            ${templateFieldsMarkup}
            <div class="event-edit-actions">
                <button type="button" class="btn btn-small" id="delete-platform-posts">Delete all posts on this platform</button>
                <button type="button" class="btn btn-small" id="delete-current-post">Delete this post</button>
                <button type="submit" class="btn btn-small">Save changes</button>
            </div>
        `;

    const templateInput = form.querySelector('[name="edit_template"]');
    templateInput?.addEventListener('change', e => {
        editEventState.template = e.target.value;
        renderEditPanel();
    });

    const addStageBtn = form.querySelector('#edit-stage-add');
    addStageBtn?.addEventListener('click', () => {
        const stageList = form.querySelector('#edit-stages-list');
        if (!stageList) return;
        const index = stageList.querySelectorAll('[data-edit-stage-row]').length;
        stageList.insertAdjacentHTML('beforeend', `
            <div class="conditional-row" data-edit-stage-row="${index}">
                <label>Stage name
                    <input type="text" name="edit_stage_name_${index}" value="">
                </label>
                <label>Stage day
                    <input type="date" name="edit_stage_date_${index}" value="">
                </label>
                <button type="button" class="btn btn-small" data-edit-stage-remove="${index}">Remove</button>
            </div>
        `);
        stageList.querySelectorAll('[data-edit-stage-remove]').forEach(button => {
            button.addEventListener('click', () => {
                const row = button.closest('[data-edit-stage-row]');
                if (row) row.remove();
            });
        });
    });

    form.querySelectorAll('[data-edit-stage-remove]').forEach(button => {
        button.addEventListener('click', () => {
            const row = button.closest('[data-edit-stage-row]');
            if (row) row.remove();
        });
    });

    form.querySelector('#delete-current-post')?.addEventListener('click', async () => {
        const groups = getGroupedModalPosts(editEventState.posts);
        const activeGroup = groups.find(group => group.key === modalPlatform) || groups[0];
        if (!activeGroup?.posts?.length) return;
        const current = activeGroup.posts[modalIndex] || activeGroup.posts[0];
        if (!current?.id) return;
        if (!confirm('Delete this post?')) return;

        const r = await fetch(
            `/api/events/${encodeURIComponent(selectedEventId)}/posts/${encodeURIComponent(current.id)}`,
            { method: 'DELETE' }
        );
        const body = await r.json().catch(() => ({}));
        if (!r.ok) {
            alert(body.error || 'Could not delete the post.');
            return;
        }

        await reloadAfterDelete();
    });

    form.querySelector('#delete-platform-posts')?.addEventListener('click', async () => {
        const platform = modalPlatform;
        if (!platform) return;
        if (!confirm(`Delete all posts on ${platform}?`)) return;

        const r = await fetch(
            `/api/events/${encodeURIComponent(selectedEventId)}/platform/${encodeURIComponent(platform)}`,
            { method: 'DELETE' }
        );
        const body = await r.json().catch(() => ({}));
        if (!r.ok) {
            alert(body.error || 'Could not delete the posts.');
            return;
        }

        await reloadAfterDelete();
    });

    form.addEventListener('submit', async e => {
        e.preventDefault();
        const formData = new FormData(e.target);
        const result = {
            name: String(formData.get('edit_name') || '').trim(),
            description: String(formData.get('edit_description') || '').trim(),
            poster: String(formData.get('edit_poster') || ''),
            template: String(formData.get('edit_template') || editEventState.template),
            dates: {},
            options: {},
            posts: (editEventState.posts || []).map(post => ({
                id: post.id || post._id,
                title: post.title,
                text: post.text,
                channelId: post.channelId,
                channelName: post.channelName,
                channelService: post.channelService,
                dueAt: post.title === "Event day" ? formData.get('edit_eventDay') : post.dueAt,
                imageUrl: post.imageUrl,
                status: post.status
            }))
        };

        const tpl = data.templates[result.template] || { kind: 'single-stage' };

        if (tpl.kind === 'single-stage') {
            result.dates.eventDay = formData.get('edit_eventDay') || '';
            result.options.announceEnabled = !!formData.get('edit_announceEnabled');
            result.options.announceDate = formData.get('edit_announceDate') || '';
            result.options.thankYouEnabled = !!formData.get('edit_thankYouEnabled');
            result.options.thankYouDate = formData.get('edit_thankYouDate') || '';
            result.options.thankYouText = String(formData.get('edit_thankYouText') || '');
        } else if (tpl.kind === 'multiple-stages') {
            const stages = [];
            const stageCount = form.querySelectorAll('[data-edit-stage-row]').length || 0;
            for (let i = 0; i < stageCount; i++) {
                const stageName = String(formData.get(`edit_stage_name_${i}`) || '').trim();
                const stageDate = String(formData.get(`edit_stage_date_${i}`) || '').trim();
                if (stageName || stageDate) stages.push({ name: stageName, date: stageDate });
            }
            result.options.stages = stages;
        }

        if (!result.name) {
            alert('Please add an event title.');
            return;
        }

        const saveResult = await fetch(`/api/events/${encodeURIComponent(selectedEventId)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(result)
        });

        const body = await saveResult.json().catch(() => ({}));
        if (!saveResult.ok) {
            alert(body.error || 'Could not save changes.');
            return;
        }

        modalEditMode = false;
        const details = await loadEventDetails(selectedEventId);
        editEventState = details;
        modalPosts = Array.isArray(details.posts) ? details.posts.filter(Boolean) : [];
        modalPlatform = getGroupedModalPosts(modalPosts)[0]?.key || '';
        modalIndex = 0;
        $('event-modal-title').textContent = details.name;
        renderPlatformTabs();
        renderModalSlide();
        renderEditPanel();
        syncModalEditorVisibility();
        init();
    });
}

async function loadEventDetails(eventId) {
    const res = await fetch(`/api/events/${encodeURIComponent(eventId)}`);
    if (!res.ok) throw new Error('Could not load event details');
    return res.json();
}

async function openEventModal(eventObj) {
    try {
        const details = await loadEventDetails(eventObj.id);
        editEventState = details;
        modalPosts = Array.isArray(details.posts) ? details.posts.filter(Boolean) : [];
        const groups = getGroupedModalPosts(modalPosts);
        modalPlatform = groups[0]?.key || '';
        modalIndex = 0;
        modalEditMode = false;
        $('event-modal-title').textContent = details.name || eventObj.name;
        $('event-modal').hidden = false;
        renderPlatformTabs();
        renderModalSlide();
        renderEditPanel();
        syncModalEditorVisibility();

        document.body.style.overflow = 'hidden'; //no scroll
    } catch (err) {
        console.error(err);
        alert(err.message || 'Could not open event details.');
    }
}

async function init() {
    const r = await fetch('/api/me');
    if (!r.ok) return (location.href = '/home');
    data = await r.json();

    // const name = data.email.split('@')[0];
    const name = data.name;
    $('greeting').textContent = `Hello, ${name}!`;
    $('today').textContent = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

    $('stat-channels').textContent = data.channels.length;
    $('stat-events').textContent = data.events.length;
    $('stat-posts').textContent = data.events.reduce((s, e) => s + e.posts, 0);

    $('channels-list').innerHTML = data.channels.map(c => `
        <div class="card chan"><div class="chan-dot">${c.service[0].toUpperCase()}</div>
        <div><h3 style="margin:0;font-size:16px">${c.name}</h3><p class="label">${c.service}</p></div></div>`).join('')
        || '<p class="subtitle">No channels yet. Connect one in Buffer.</p>';

    function renderEvents() {
        const list = $('events-list');
        list.innerHTML = data.events.map(e => `
            <article class="card event-card" data-event-id="${e.id}">
                <p class="label">${e.template}</p>
                <h3>${e.name}</h3>
                <p class="card-text">${e.posts} posts scheduled</p>
                <p class="event-click-hint">Click for details</p>
            </article>`).join('') || '<p class="subtitle">No events yet. Start one below.</p>';

        list.querySelectorAll('[data-event-id]').forEach(el => {
            el.addEventListener('click', () => {
                selectedEventId = el.getAttribute('data-event-id');
                const eventObj = data.events.find(x => String(x.id) === String(selectedEventId));
                if (eventObj) openEventModal(eventObj);
            });
        });

        if (!data.events.length) {
            selectedEventId = null;
        }
    }

    renderEvents();

    $('channel-checks').innerHTML = data.channels.map(c =>
        `<label><input type="checkbox" value="${c.id}|${c.service}" checked> ${c.name} (${c.service})</label>`).join('');

    // nu permite postari pe ig fara imagini
    function checkInstagramChannels() {
        const checkedBoxes = $('channel-checks').querySelectorAll('input[type="checkbox"]:checked');
        const hasInstagram = Array.from(checkedBoxes).some(cb => cb.value.includes('instagram'));
        const selectedPoster = document.querySelector('input[name="poster"]:checked')?.value;
        
        // console.log(hasInstagram);
        // console.log(selectedPoster);

        const submitBtn = $('submit-btn');
        
        let msgContainer = $('ig-error-msg');
        if (!msgContainer) {
            msgContainer = document.createElement('div');
            msgContainer.id = 'ig-error-msg';
            msgContainer.className = 'subtitle';
            msgContainer.style.fontSize = 'smaller'; 
            msgContainer.style.marginTop = '0px';
            submitBtn.insertAdjacentElement('afterend', msgContainer);
        }

        if (hasInstagram && selectedPoster === "") {
            submitBtn.disabled = true;
            submitBtn.style.cursor = 'inherit';
            msgContainer.style.marginTop = '3px';
            msgContainer.textContent = 'Posting to Instagram is not possible without a template.';
        } else {
            submitBtn.disabled = false;
            msgContainer.textContent = '';
        }
    }

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
    
    $('channel-checks').addEventListener('change', checkInstagramChannels);
    $('poster-picker').addEventListener('change', checkInstagramChannels);
    checkInstagramChannels();

    $('poster-picker').addEventListener('change', updatePreview);
    $('event-form').elements['name'].addEventListener('input', updatePreview);
    $('event-form').elements['description'].addEventListener('input', updatePreview);
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
                <br class="hidd">

                <div class="conditional-row">
                    <label class="checkbox-label">
                        <input type="checkbox" id="single-announce-enabled" name="single_announceEnabled">
                        <span>Publish an advance announcement</span>
                    </label>

                    <div id="single-announce-date-wrap" class="conditional-reveal" hidden>
                        <label>Advance post date
                            <input type="date" id="single-announce-date" name="single_announceDate" disabled>
                        </label>
                    </div>
                </div>

                <div class="conditional-row">
                    <label class="checkbox-label">
                        <input type="checkbox" id="single-thankyou-enabled" name="single_thankYouEnabled">
                        <span>Publish a thank-you post</span>
                    </label>

                    <div id="single-thankyou-fields" class="conditional-reveal" hidden>
                        <label>Thank-you message
                            <textarea name="single_thankYouText" rows="3" placeholder="e.g. Thank you for joining us!"></textarea>
                        </label>

                        <label>Thank-you date (optional)
                            <input type="date" id="single-thankyou-date" name="single_thankYouDate" disabled>
                        </label>

                        <small id="single-thankyou-fallback" class="subtitle">
                            If this date is empty, the thank-you post will be published 7 days after event day.
                        </small>
                    </div>
                </div>
            `;

            const announceCheckbox = document.getElementById('single-announce-enabled');
            const announceDateWrap = document.getElementById('single-announce-date-wrap');
            const announceDate = document.getElementById('single-announce-date');

            announceCheckbox.addEventListener('change', () => {
                announceDateWrap.hidden = !announceCheckbox.checked;
                announceDate.disabled = !announceCheckbox.checked;
            });

            const thankyouCheckbox = document.getElementById('single-thankyou-enabled');
            const thankyouFields = document.getElementById('single-thankyou-fields');
            const thankyouDate = document.getElementById('single-thankyou-date');

            thankyouCheckbox.addEventListener('change', () => {
                thankyouFields.hidden = !thankyouCheckbox.checked;
                thankyouDate.disabled = !thankyouCheckbox.checked;
            });

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

    if (!modalListenersBound) {
        $('modal-close').addEventListener('click', closeEventModal);
        $('event-modal').addEventListener('click', e => {
            if (e.target.closest('[data-close-modal="1"]')) closeEventModal();
        });
        $('modal-prev').addEventListener('click', () => {
            if (modalIndex <= 0) return;
            modalIndex -= 1;
            renderModalSlide();
        });
        $('modal-next').addEventListener('click', () => {
            if (modalIndex >= modalPosts.length - 1) return;
            modalIndex += 1;
            renderModalSlide();
        });
        document.addEventListener('keydown', e => {
            if ($('event-modal').hidden) return;
            if (e.key === 'Escape') closeEventModal();
            if (e.key === 'ArrowLeft' && modalIndex > 0) {
                modalIndex -= 1;
                renderModalSlide();
            }
            if (e.key === 'ArrowRight' && modalIndex < modalPosts.length - 1) {
                modalIndex += 1;
                renderModalSlide();
            }
        });
        modalListenersBound = true;
    }

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
                    channels: [...document.querySelectorAll('#channel-checks input:checked')].map(i => i.value),
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
            box.innerHTML = `<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                <h3 style="margin: 0;">${r.ok ? 'Done' : 'Something went wrong: ' + out.error}</h3>
                <button type="button" id="close-box-btn" style="background: none; border: none; font-size: 20px; cursor: pointer; padding: 0 5px;" title="Close">&times;</button>
            </div><ul>` + 
            (out.results || []).map(x => `<li><b>${x.title}</b>${x.channel ? ' · ' + x.channel : ''}
            ${x.dueAt ? ' · ' + new Date(x.dueAt).toLocaleDateString('en-GB') : ''}
            · <span class="${x.status === 'scheduled' ? 'ok' : 'warn'}">${x.status}</span>${x.image ? `<br><a href="${x.image}" target="_blank"><img class="res-img" src="${x.image}" alt=""></a>` : ''}</li>`).join('') + '</ul>';

            // hide box when clicking on close button from box
            box.querySelector('#close-box-btn')?.addEventListener('click', () => {
                box.hidden = true;
            });

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
        const emptyMsg = $('poster-preview-empty');
        if (!poster) {
            box.hidden = true;
            emptyMsg.hidden = false;
            return;
        }
        emptyMsg.hidden = true;

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
        const description = $('event-form').elements['description']?.value || '';

        const q = new URLSearchParams({
            bg: poster,
            eyebrow: $('event-form').elements['name'].value || 'Event name',
            headline,
            description,
            line
        });
        box.src = `/api/poster.png?${q}`;
        box.hidden = false;
    }, 300);
}
init();