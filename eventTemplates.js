const fmt = d => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });

module.exports = {
    admission: {
        name: 'Admission contest (2 stages)',
        fields: {
        registrationOpen: 'Registrations open',
        stage1: 'Stage 1 exam',
        stage1Results: 'Stage 1 results',
        stage2: 'Stage 2 exam',
        finalResults: 'Final results'
        },
        posts: [
        { title: 'Awareness', at: 'registrationOpen', days: -7,
            text: e => `${e.name} is coming. ${e.description} Registrations open on ${fmt(e.dates.registrationOpen)}.` },
        { title: 'Registrations open', at: 'registrationOpen', days: 0,
            text: e => `Registrations for ${e.name} are now open. Stage 1 takes place on ${fmt(e.dates.stage1)}.` },
        { title: 'Stage 1 reminder', at: 'stage1', days: -3,
            text: e => `Reminder: Stage 1 of ${e.name} is in 3 days, on ${fmt(e.dates.stage1)}.` },
        { title: 'Stage 1 exam day', at: 'stage1', days: 0,
            text: e => `Today is Stage 1 of ${e.name}. Good luck to everyone!` },
        { title: 'Stage 1 results', at: 'stage1Results', days: 0,
            text: e => `Stage 1 results for ${e.name} are out. Stage 2 is on ${fmt(e.dates.stage2)}.` },
        { title: 'Stage 2 reminder', at: 'stage2', days: -3,
            text: e => `Reminder: Stage 2 of ${e.name} is in 3 days, on ${fmt(e.dates.stage2)}.` },
        { title: 'Stage 2 exam day', at: 'stage2', days: 0,
            text: e => `Today is Stage 2 of ${e.name}. Best of luck!` },
        { title: 'Final results', at: 'finalResults', days: 0,
            text: e => `The final results of ${e.name} are here. Congratulations to all participants!` },
        { title: 'Thank you', at: 'finalResults', days: 2,
            text: e => `Thank you to everyone who took part in ${e.name}. See you next time!` }
        ]
    },

    simple: {
        name: 'Single-stage event',
        fields: { registrationOpen: 'Registrations open', event: 'Event day', results: 'Results' },
        posts: [
        { title: 'Awareness', at: 'registrationOpen', days: -7,
            text: e => `${e.name} is coming. ${e.description} Registrations open on ${fmt(e.dates.registrationOpen)}.` },
        { title: 'Registrations open', at: 'registrationOpen', days: 0,
            text: e => `Registrations for ${e.name} are open. The event is on ${fmt(e.dates.event)}.` },
        { title: 'Reminder', at: 'event', days: -3,
            text: e => `Reminder: ${e.name} is in 3 days, on ${fmt(e.dates.event)}.` },
        { title: 'Event day', at: 'event', days: 0,
            text: e => `Today is the day: ${e.name}!` },
        { title: 'Results', at: 'results', days: 0,
            text: e => `The results of ${e.name} are out. Congratulations!` },
        { title: 'Thank you', at: 'results', days: 2,
            text: e => `Thank you to everyone who joined ${e.name}.` }
        ]
    }
};