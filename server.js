const express = require('express');
const mongoose = require('mongoose');
const cron = require('node-cron');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors({
  origin: ['https://joannemeda.github.io', 'https://your-heroku-app.herokuapp.com'], // Add Heroku domain later
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Accept']
}));
app.use(express.json());

// MongoDB Connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/test';
mongoose.connect(MONGODB_URI, { 
  serverSelectionTimeoutMS: 30000,
  socketTimeoutMS: 45000,
  heartbeatFrequencyMS: 10000,
  maxPoolSize: 10
})
.then(() => console.log('Connected to MongoDB successfully'))
.catch(err => console.error('MongoDB connection failed:', err.message));

// Auction Schema (current auctions)
const auctionSchema = new mongoose.Schema({
  uuid: String,
  auctioneer: String,
  item_name: String,
  starting_bid: Number,
  tier: String,
  bin: Boolean,
  end: Number,
  item_lore: String
});
const Auction = mongoose.model('auctions', auctionSchema);

// Historical Auction Schema
const historicalAuctionSchema = new mongoose.Schema({
  _id: String, // auction uuid
  item_name: String,
  starting_bid: Number,
  tier: String,
  bin: Boolean,
  end: Number,
  auctioneer: String,
  first_seen: { type: Date, default: Date.now }
}, { timestamps: true });

historicalAuctionSchema.index({ auctioneer: 1 });
historicalAuctionSchema.index({ item_name: 1 });
historicalAuctionSchema.index({ end: 1 });

const HistoricalAuction = mongoose.model('historicalauctions', historicalAuctionSchema);

// Function to cleanup expired auctions (unchanged)
async function cleanupExpiredAuctions() {
  const now = Date.now();
  try {
    const result = await HistoricalAuction.deleteMany({ end: { $lte: now } });
    console.log(`Cleaned up ${result.deletedCount} expired auctions at ${new Date().toISOString()}`);
  } catch (error) {
    console.error('Cleanup error:', error.message);
  }
}

// Schedule cleanup every 5 minutes
cron.schedule('*/5 * * * *', cleanupExpiredAuctions);

// Placeholder for fetchAuctionsWithRetry (commented out since no API key)
async function fetchAuctionsWithRetry() {
  console.log('Auction fetching disabled due to missing Hypixel API key. Please manually populate MongoDB.');
  // If you want to re-enable, uncomment and add your API key:
  /*
  const API_ENDPOINT = `https://api.hypixel.net/skyblock/auctions?key=${process.env.HYPIXEL_API_KEY}`;
  // ... (Restore the original fetchAuctionsWithRetry logic here)
  */
}

// Schedule fetching (commented out, but kept for structure)
let fetchScheduled = false;
function scheduleFetch() {
  if (!fetchScheduled) {
    fetchScheduled = true;
    cron.schedule('*/5 * * * *', () => {
      fetchAuctionsWithRetry()
        .catch(err => console.error('Cron job failed:', err.message));
    });
  }
}

// Search Endpoint
app.get('/auctions/search', async (req, res) => {
  const { item, rarity, bin, skip } = req.query;
  let query = {};

  if (item) query.item_name = { $regex: item, $options: 'i' }; // Case-insensitive search
  if (rarity) query.tier = rarity.toUpperCase();
  if (bin) query.bin = bin === 'true';

  try {
    const skipValue = parseInt(skip, 10) || 0;
    const auctions = await Auction.find(query)
      .sort({ starting_bid: 1 }) // Default to lowest price
      .skip(skipValue)
      .limit(100)
      .lean()
      .exec();

    console.log(`Search for ${JSON.stringify(req.query)} returned ${auctions.length} auctions from 'auctions' collection`);
    if (auctions.length === 0) {
      console.warn('No auctions found for query, returning empty array');
      res.json([]); // Explicitly return empty array for 200 OK, not 404
    } else {
      res.json(auctions);
    }
  } catch (error) {
    console.error('Search error:', error.message);
    res.status(500).json({ error: 'Search failed', details: error.message });
  }
});

// Health check endpoint
app.get('/health', async (req, res) => {
  try {
    await mongoose.connection.db.admin().ping();
    res.json({ connected: true, message: 'MongoDB connection healthy', timestamp: new Date().toISOString() });
  } catch (error) {
    console.error('Health check error:', error.message);
    res.status(500).json({ connected: false, message: 'MongoDB connection failed', error: error.message });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT} at ${new Date().toISOString()}`);
  // Since no API key, we won’t fetch auctions, but keep cleanup running
  scheduleFetch();
  console.log('Auction fetching disabled. Ensure MongoDB is populated manually.');
});