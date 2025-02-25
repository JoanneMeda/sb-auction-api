const express = require('express');
const axios = require('axios');
const mongoose = require('mongoose');
const cron = require('node-cron');
const cors = require('cors');
const app = express();

// Middleware
app.use(cors({
  origin: 'https://joannemeda.github.io' // Explicitly allow GitHub Pages
}));
app.use(express.json());

// Load environment variables
require('dotenv').config();

// MongoDB Connection (using MongoDB Atlas SRV connection string, updated to 'test' database)
mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/test', { 
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
const Auction = mongoose.model('auctions', auctionSchema); // Updated collection name to match screenshot

// Historical Auction Schema (with manual cleanup for expiration)
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
historicalAuctionSchema.index({ end: 1 }); // For cleanup queries

const HistoricalAuction = mongoose.model('historicalauctions', historicalAuctionSchema); // Updated collection name to match screenshot

const API_ENDPOINT = `https://api.hypixel.net/skyblock/auctions?key=${process.env.HYPIXEL_API_KEY}`;

// Function to fetch auctions with retry logic and historical storage
async function fetchAuctionsWithRetry(retries = 3, delay = 30000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`Starting auction fetch (Attempt ${attempt}/${retries}) at ${new Date().toISOString()}...`);
      const initialResponse = await axios.get(API_ENDPOINT, { timeout: 30000 });
      if (!initialResponse.data.success) throw new Error(`Hypixel API failed: ${initialResponse.data.cause || 'Unknown error'}`);

      const totalPages = initialResponse.data.totalPages || 1;
      console.log(`Fetching ${totalPages} pages...`);

      const pagePromises = [];
      for (let i = 0; i < totalPages; i++) {
        pagePromises.push(
          axios.get(`${API_ENDPOINT}&page=${i}`, { timeout: 30000 }).then(res => {
            if (!res.data.success) throw new Error(`Page ${i} failed: ${res.data.cause || 'Unknown error'}`);
            return res.data.auctions || [];
          })
        );
      }
      const allPagesData = await Promise.all(pagePromises);
      const allAuctions = allPagesData.flat();
      console.log(`Retrieved ${allAuctions.length} auctions from API`);

      // Store new auctions in historical collection, excluding duplicates
      let newAuctionsCount = 0;
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
          newAuctionsCount++;
        }
      }
      console.log(`Cached ${newAuctionsCount} new unique auctions in history`);

      // Clean up expired auctions
      await cleanupExpiredAuctions();

      // Update current auctions (Auction collection)
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
      console.error('Fetch error:', {
        message: error.message,
        status: error.response?.status,
        attempt,
        timestamp: new Date().toISOString()
      });
      if (error.code === 'ECONNABORTED') {
        console.error(`Request timed out (Attempt ${attempt}/${retries}). Retrying in ${delay / 1000} seconds...`);
      } else if (error.response && error.response.status === 429) {
        console.error('Rate limit hit (429). Retrying in 60 seconds...');
        await new Promise(resolve => setTimeout(resolve, 60000));
      } else {
        console.error('Unexpected error. Retrying...');
      }
      if (attempt === retries) throw error;
      await new Promise(resolve => setTimeout(resolve, delay * attempt));
    }
  }
}

// Cleanup function for expired auctions (manual, as TTL with milliseconds is unreliable)
async function cleanupExpiredAuctions() {
  const now = Date.now();
  try {
    const result = await HistoricalAuction.deleteMany({ end: { $lte: now } });
    console.log(`Cleaned up ${result.deletedCount} expired auctions at ${new Date().toISOString()}`);
  } catch (error) {
    console.error('Cleanup error:', error.message);
  }
}

// Schedule cleanup every 5 minutes (aligned with auction fetch for timely removal)
cron.schedule('*/5 * * * *', cleanupExpiredAuctions); // Every 5 minutes, aligned with auction fetch

// Schedule fetching every 5 minutes (continuous caching)
cron.schedule('*/5 * * * *', () => {
  fetchAuctionsWithRetry()
    .catch(err => console.error('Cron job failed:', err.message));
});

// Search Endpoint (current auctions, querying cached data from 'test' database)
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
      .lean() // Use lean for faster queries
      .exec();
    console.log(`Search for ${JSON.stringify(req.query)} returned ${auctions.length} auctions from 'test.auctions'`);
    res.json(auctions);
  } catch (error) {
    console.error('Search error:', error.message);
    res.status(500).json({ error: 'Search failed', details: error.message });
  }
});

// Health check endpoint for frontend verification
app.get('/health', async (req, res) => {
  try {
    await mongoose.connection.db.admin().ping();
    res.json({ connected: true, message: 'MongoDB connection healthy' });
  } catch (error) {
    console.error('Health check error:', error.message);
    res.status(500).json({ connected: false, message: 'MongoDB connection failed' });
  }
});

// Start Server
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT} at ${new Date().toISOString()}`);
  fetchAuctionsWithRetry() // Initial fetch (starts caching immediately upon deployment)
    .catch(err => console.error('Initial fetch failed:', err.message));
});