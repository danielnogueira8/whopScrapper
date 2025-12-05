const mongoose = require('mongoose');

const scrapeResultSchema = new mongoose.Schema({
  searchQuery: {
    type: String,
    required: true,
    index: true,
  },
  maxProducts: {
    type: Number,
    required: true,
  },
  products: [{
    productName: String,
    productUrl: String,
    creatorName: String,
    creatorHandle: String,
    price: String,
    paymentFrequency: String,
    twitter: String,
    instagram: String,
    youtube: String,
    tiktok: String,
    discord: String,
    linkedin: String,
    telegram: String,
  }],
  stats: {
    total: Number,
    withTwitter: Number,
    withInstagram: Number,
    withYouTube: Number,
    withTikTok: Number,
    withDiscord: Number,
    withLinkedIn: Number,
    withTelegram: Number,
  },
  csvData: String,
  filename: String,
  createdAt: {
    type: Date,
    default: Date.now,
    index: true,
  },
}, {
  timestamps: true,
});

// Index for faster queries
scrapeResultSchema.index({ createdAt: -1 });
scrapeResultSchema.index({ searchQuery: 1, createdAt: -1 });

module.exports = mongoose.model('ScrapeResult', scrapeResultSchema);

