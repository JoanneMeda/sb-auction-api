const express = require('express');
const axios = require('axios');
const mongoose = require('mongoose');
const cron = require('node-cron');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors({
  origin: 'https://joannemeda.github.io'
}));
app.use(express.json());

// MongoDB Connection (remove deprecated options)
mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/test', { 
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

const API_ENDPOINT = `https://api.hypixel.net/skyblock/auctions?key=${process.env.HYPIXEL_API_KEY}`;

// Function to fetch auctions with retry logic, batching, and duplicate handling
async function fetchAuctionsWithRetry(retries = 5, delay = 30000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`Starting auction fetch (Attempt ${attempt}/${retries}) at ${new Date().toISOString()}...`);
      const initialResponse = await axios.get(API_ENDPOINT, { timeout: 30000 });
      if (!initialResponse.data.success) throw new Error(`Hypixel API failed: ${initialResponse.data.cause || 'Unknown error'}`);

      const totalPages = initialResponse.data.totalPages || 1;
      console.log(`Fetching ${totalPages} pages...`);

      const pagePromises = [];
      const apiBatchSize = 5; // Fetch 5 pages at a time to reduce memory
      for (let i = 0; i < totalPages; i += apiBatchSize) {
        const batchPages = Array.from({ length: Math.min(apiBatchSize, totalPages - i) }, (_, j) => i + j);
        pagePromises.push(
          Promise.all(batchPages.map(page =>
            axios.get(`${API_ENDPOINT}&page=${page}`, { timeout: 30000 }).then(res => {
              if (!res.data.success) throw new Error(`Page ${page} failed: ${res.data.cause || 'Unknown error'}`);
              return res.data.auctions || [];
            })
          ))
        );
      }
      const allPagesData = (await Promise.all(pagePromises)).flat();
      const allAuctions = allPagesData.flat();
      console.log(`Retrieved ${allAuctions.length} auctions from API`);

      let newAuctionsCount = 0;
      for (const auction of allAuctions) {
        try {
          const exists = await HistoricalAuction.exists({ _id: auction.uuid });
          if (!exists) {
            const newHistoricalAuction = new HistoricalAuction({
              _id: auction.uuid,
              item_name: auction.item_name,
              starting_bid: auction.starting_bid,
              tier: auction.tier,
              bin: auction.bin,
              end: auction.end,
              auctioneer: auction.auctioneer
            });
            await newHistoricalAuction.save({ upsert: true, runValidators: true });
            newAuctionsCount++;
          }
        } catch (error) {
          if (error.code === 11000) {
            console.warn(`Duplicate UUID ${auction.uuid} ignored: ${error.message}`);
          } else {
            throw error;
          }
        }
      }
      console.log(`Cached ${newAuctionsCount} new unique auctions in history`);

      await cleanupExpiredAuctions();

      console.log('Dropping old auctions...');
      await Auction.collection.drop().catch(err => {
        if (err.codeName !== 'NamespaceNotFound') throw err;
        console.log('Collection didn’t exist or dropped');
      });
      console.log('Inserting new auctions in batches...');
      const mongoBatchSize = 1000; // Separate variable to avoid redeclaration
      for (let i = 0; i < allAuctions.length; i += mongoBatchSize) {
        const batch = allAuctions.slice(i, i + mongoBatchSize);
        await Auction.insertMany(batch, { ordered: false });
        console.log(`Inserted batch ${i / mongoBatchSize + 1} of ${Math.ceil(allAuctions.length / mongoBatchSize)}`);
      }
      console.log(`Cached ${allAuctions.length} auctions successfully`);
      return;
    } catch (error) {
      console.error('Fetch error:', {
        message: error.message,
        status: error.response?.status,
        attempt,
        timestamp: new Date().toISOString()
      });
      if (error.response?.status === 429) {
        const waitTime = Math.min(60000 * attempt, 300000); // Up to 5 minutes
        console.error(`Rate limit hit (429). Retrying in ${waitTime / 1000} seconds...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      } else if (error.code === 'ECONNABORTED') {
        console.error(`Request timed out (Attempt ${attempt}/${retries}). Retrying in ${delay / 1000} seconds...`);
      } else {
        console.error('Unexpected error. Retrying...');
      }
      if (attempt === retries) throw error;
      await new Promise(resolve => setTimeout(resolve, delay * attempt));
    }
  }
}

// Cleanup function for expired auctions
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

// Schedule fetching every 5 minutes (deferred after server start)
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

  if (item) query.item_name = { $regex: item, $options: 'i' };
  if (rarity) query.tier = rarity.toUpperCase();
  if (bin) query.bin = bin === 'true';

  try {
    const skipValue = parseInt(skip, 10) || 0;
    const auctions = await Auction.find(query)
      .sort({ starting_bid: 1 })
      .skip(skipValue)
      .limit(100)
      .lean()
      .exec();
    console.log(`Search for ${JSON.stringify(req.query)} returned ${auctions.length} auctions from 'test.auctions'`);
    res.json(auctions);
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

// Start server and bind to $PORT immediately, then schedule fetch
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT} at ${new Date().toISOString()}`);
  // Schedule the initial fetch after server starts
  fetchAuctionsWithRetry()
    .then(() => scheduleFetch())
    .catch(err => console.error('Initial fetch failed:', err.message));
});