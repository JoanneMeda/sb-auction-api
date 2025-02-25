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

// Auction Schema
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

const API_ENDPOINT = 'https://api.hypixel.net/skyblock/auctions';

// Function to fetch auctions with retry logic
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
          axios.get(`${API_ENDPOINT}?page=${i}`, { timeout: 30000 }).then(res => res.data.auctions)
        );
      }
      const allPagesData = await Promise.all(pagePromises);
      const auctions = allPagesData.flat();
      console.log(`Retrieved ${auctions.length} auctions from API`);

      console.log('Dropping old auctions...');
      await Auction.collection.drop().catch(err => {
        if (err.codeName !== 'NamespaceNotFound') throw err;
        console.log('Collection didn’t exist or dropped');
      });
      console.log('Inserting new auctions in batches...');
      const batchSize = 1000;
      for (let i = 0; i < auctions.length; i += batchSize) {
        const batch = auctions.slice(i, i + batchSize);
        await Auction.insertMany(batch, { ordered: false }); // Ordered: false to continue on duplicate errors
        console.log(`Inserted batch ${i / batchSize + 1} of ${Math.ceil(auctions.length / batchSize)}`);
      }
      console.log(`Cached ${auctions.length} auctions successfully`);
      return; // Exit on success
    } catch (error) {
      console.error('Fetch error:', error.message);
      if (error.code === 'ECONNABORTED') {
        console.error(`Request timed out (Attempt ${attempt}/${retries}). Retrying in ${delay / 1000} seconds...`);
      } else if (error.response && error.response.status === 429) {
        console.error('Rate limit hit (429). Retrying in 60 seconds...');
        await new Promise(resolve => setTimeout(resolve, 60000)); // Wait longer for rate limits
      } else {
        console.error('Unexpected error. Retrying...');
      }
      if (attempt === retries) throw error; // Throw after max retries
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

// Schedule fetching every 5 minutes
cron.schedule('*/5 * * * *', () => {
  fetchAuctionsWithRetry()
    .catch(err => console.error('Cron job failed:', err.message));
});

// Search Endpoint
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

// Start Server
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  fetchAuctionsWithRetry() // Initial fetch
    .catch(err => console.error('Initial fetch failed:', err.message));
});