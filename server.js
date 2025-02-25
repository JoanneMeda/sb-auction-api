const express = require('express');
const axios = require('axios');
const mongoose = require('mongoose');
const cron = require('node-cron');
const cors = require('cors');
const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Load environment variables
require('dotenv').config();

// MongoDB Connection (using MongoDB Atlas SRV connection string)
mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/skyblock_auctions', { 
  useNewUrlParser: true, 
  useUnifiedTopology: true,
  serverSelectionTimeoutMS: 30000, // 30 seconds
  socketTimeoutMS: 45000, // 45 seconds
  heartbeatFrequencyMS: 10000, // Check connection every 10 seconds
  maxPoolSize: 10 // Increase connection pool size
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
const Auction = mongoose.model('Auction', auctionSchema);

// Historical Auction Schema (with TTL for expiration)
const historicalAuctionSchema = new mongoose.Schema({
    _id: String, // auction uuid
    item_name: String,
    starting_bid: Number,
    tier: String,
    bin: Boolean,
    end: Number, // Hypixel end time in milliseconds
    auctioneer: String,
    first_seen: { type: Date, default: Date.now }
}, { timestamps: true });

// Define indexes on the schema
historicalAuctionSchema.index({ auctioneer: 1 });
historicalAuctionSchema.index({ item_name: 1 });
historicalAuctionSchema.index({ end: 1 }); // For TTL or cleanup queries

// Use TTL index for automatic deletion when end time is reached
// Note: MongoDB TTL works with seconds or dates; milliseconds may need conversion
historicalAuctionSchema.index({ end: 1 }, { expireAfterSeconds: 0 }); // Deletes when end (milliseconds) is reached

const HistoricalAuction = mongoose.model('HistoricalAuction', historicalAuctionSchema);

const API_ENDPOINT = `https://api.hypixel.net/skyblock/auctions?key=${process.env.HYPIXEL_API_KEY}`;

// Function to fetch auctions with retry logic and historical storage
async function fetchAuctionsWithRetry(retries = 3, delay = 30000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`Starting auction fetch (Attempt ${attempt}/${retries})...`);
      const initialResponse = await axios.get(API_ENDPOINT, { timeout: 30000 });
      const totalPages = initialResponse.data.totalPages;
      console.log(`Fetching ${totalPages} pages...`);

      const pagePromises = [];
      for (let i = 0; i < totalPages; i++) {
        pagePromises.push(
          axios.get(`${API_ENDPOINT}&page=${i}`, { timeout: 30000 }).then(res => res.data.auctions)
        );
      }
      const allPagesData = await Promise.all(pagePromises);
      const allAuctions = allPagesData.flat();
      console.log(`Retrieved ${allAuctions.length} auctions from API`);

      // Store new auctions in historical collection, excluding duplicates
      for (const auction of allAuctions) {
        const exists = await HistoricalAuction.exists({ _id: auction.uuid });
        if (!exists) {
          const newHistoricalAuction = new HistoricalAuction({
            _id: auction.uuid,
            item_name: auction.item_name,
            starting_bid: auction.starting_bid,
            tier: auction.tier,
            bin: auction.bin,
            end: auction.end, // Hypixel end time in milliseconds
            auctioneer: auction.auctioneer
          });
          await newHistoricalAuction.save();
        }
      }
      console.log(`Cached ${allAuctions.length} unique auctions in history`);

      // Clean up expired auctions (manual, if TTL fails)
      await cleanupExpiredAuctions();

      // Existing logic for current auctions (Auction collection)
      console.log('Dropping old auctions...');
      await Auction.collection.drop().catch(err => {
        if (err.codeName !== 'NamespaceNotFound') throw err;
        console.log('Collection didn’t exist or dropped');
      });
      console.log('Inserting new auctions in batches...');
      const batchSize = 1000;
      for (let i = 0; i < allAuctions.length; i += batchSize) {
        const batch = allAuctions.slice(i, i + batchSize);
        await Auction.insertMany(batch, { ordered: false }); // Ordered: false to continue on duplicate errors
        console.log(`Inserted batch ${i / batchSize + 1} of ${Math.ceil(allAuctions.length / batchSize)}`);
      }
      console.log(`Cached ${allAuctions.length} auctions successfully`);
      return;
    } catch (error) {
      console.error('Fetch error:', error.message);
      if (error.code === 'ECONNABORTED') {
        console.error(`Request timed out (Attempt ${attempt}/${retries}). Retrying in ${delay / 1000} seconds...`);
      } else if (error.response && error.response.status === 429) {
        console.error('Rate limit hit (429). Retrying in 60 seconds...');
        await new Promise(resolve => setTimeout(resolve, 60000));
      } else {
        console.error('Unexpected error. Retrying...');
      }
      if (attempt === retries) throw error;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

// Cleanup function for expired auctions (manual, if TTL not used)
async function cleanupExpiredAuctions() {
  const now = Date.now();
  try {
    const result = await HistoricalAuction.deleteMany({ end: { $lte: now } });
    console.log(`Cleaned up ${result.deletedCount} expired auctions`);
  } catch (error) {
    console.error('Cleanup error:', error.message);
  }
}

// Schedule cleanup (e.g., daily or on each fetch, depending on load)
cron.schedule('0 0 * * *', cleanupExpiredAuctions); // Daily at midnight

// Schedule fetching every 5 minutes
cron.schedule('*/5 * * * *', () => {
  fetchAuctionsWithRetry()
    .catch(err => console.error('Cron job failed:', err.message));
});

// Search Endpoint (current auctions)
app.get('/auctions/search', async (req, res) => {
  const { ign, item, rarity, bin, skip } = req.query;
  let query = {};

  if (item) query.item_name = { $regex: item, $options: 'i' };
  if (rarity) query.tier = rarity.toUpperCase();
  if (bin) query.bin = bin === 'true';

  if (ign) {
    try {
      const uuidResponse = await axios.get(`https://api.mojang.com/users/profiles/minecraft/${ign}`, { timeout: 10000 });
      const uuid = uuidResponse.data?.id?.replace(/-/g, '');
      if (uuid) query.auctioneer = uuid;
    } catch (error) {
      console.error(`UUID fetch error for ${ign}:`, error.message);
    }
  }

  try {
    const skipValue = parseInt(skip, 10) || 0;
    const auctions = await Auction.find(query)
      .sort({ starting_bid: 1 })
      .skip(skipValue)
      .limit(100)
      .lean() // Use lean for faster queries
      .exec();
    res.json(auctions);
  } catch (error) {
    res.status(500).json({ error: 'Search failed', details: error.message });
  }
});

// Historical Player Auctions Endpoint (with time filtering)
app.get('/auctions/historical/player', async (req, res) => {
  const { ign, uuid, activeOnly } = req.query;
  let playerUuid;
  if (ign) {
    const response = await fetch(`https://api.mojang.com/users/profiles/minecraft/${ign}`);
    const data = await response.json();
    playerUuid = data.id.replace(/-/g, '');
  } else if (uuid) {
    playerUuid = uuid.replace(/-/g, '');
  } else {
    return res.status(400).json({ error: 'Either ign or uuid must be provided' });
  }

  try {
    let query = { auctioneer: playerUuid };
    if (activeOnly === 'true') {
      query.end = { $gt: Date.now() }; // Only active auctions
    }
    const auctions = await HistoricalAuction.find(query).lean().exec();
    res.json(auctions);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch historical auctions', details: error.message });
  }
});

// Historical Item Auctions Endpoint (with time filtering)
app.get('/auctions/historical/item', async (req, res) => {
  const { item, activeOnly } = req.query;
  if (!item) return res.status(400).json({ error: 'Item name must be provided' });

  try {
    let query = { item_name: { $regex: new RegExp(item, 'i') } };
    if (activeOnly === 'true') {
      query.end = { $gt: Date.now() }; // Only active auctions
    }
    const auctions = await HistoricalAuction.find(query).lean().exec();
    res.json(auctions);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch historical item auctions', details: error.message });
  }
});

// Start Server
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  fetchAuctionsWithRetry() // Initial fetch
    .catch(err => console.error('Initial fetch failed:', err.message));
});