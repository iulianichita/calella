const mongoose = require('mongoose');

const eventSchema = new mongoose.Schema({
    userId: { type: String, index: true },     // id-ul contului Buffer
    name: String,
    description: String,
    template: String,
    poster: String,
    tags: [String],
    channelIds: [String],
    dates: { type: Map, of: String },
    posts: [{
        title: String,
        channelId: String,
        channelName: String,
        channelService: String,
        bufferPostId: String,
        dueAt: Date,
        imageUrl: String,
        status: String
    }],
    options: mongoose.Schema.Types.Mixed,
}, { timestamps: true });

module.exports = mongoose.model('Event', eventSchema);