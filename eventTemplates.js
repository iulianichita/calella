const fmt = d => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });

const addDays = (dateStr, days) => {
    const d = new Date(`${dateStr}T10:00:00.000Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
};

module.exports = {
    singleStage: {
        name: 'Single-stage event',
        kind: 'single-stage',
        fields: { eventDay: 'Event day' },
        buildPosts: (event) => {
            const eventDay = event.dates.eventDay;
            const posts = [];

            if (event.options?.announceEnabled && event.options?.announceDate) {
                posts.push({
                    title: 'Event announcement',
                    dueDate: event.options.announceDate,
                    lineDate: event.options.announceDate,
                    text: e => `${e.name} is coming on ${fmt(eventDay)}. ${e.description}`.trim()
                });
            }

            posts.push({
                title: 'Event day',
                dueDate: eventDay,
                lineDate: eventDay,
                text: e => `Today is the day: ${e.name}!`
            });

            if (event.options?.thankYouEnabled) {
                const thankYouDate = event.options?.thankYouDate || addDays(eventDay, 7);
                const customThanks = (event.options?.thankYouText || '').trim();
                posts.push({
                    title: 'Thank you',
                    dueDate: thankYouDate,
                    lineDate: thankYouDate,
                    text: e => customThanks || `Thank you to everyone who joined ${e.name}.`
                });
            }

            return posts;
        }
    },

    multipleStages: {
        name: 'Multiple stages event',
        kind: 'multiple-stages',
        fields: {},
        buildPosts: (event) => {
            const stages = (event.options?.stages || []).filter(s => s?.name && s?.date);

            return stages.map((stage, i) => ({
                title: stage.name,
                dueDate: stage.date,
                lineDate: stage.date,
                text: e => `Stage ${i + 1} (${stage.name}) of ${e.name} is happening today, ${fmt(stage.date)}.`
            }));
        }
    }
};