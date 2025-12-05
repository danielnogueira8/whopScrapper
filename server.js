const express = require('express');
const path = require('path');
const { runScraper, exportToCSV } = require('./scraper');
const { connectDB } = require('./db/connection');
const ScrapeResult = require('./models/ScrapeResult');

const app = express();
const BASE_PORT = process.env.PORT || 3000;
const MAX_PORT_ATTEMPTS = 100; // Try up to 100 ports

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Connect to MongoDB
connectDB().catch(console.error);

// API endpoint to run scraper with Server-Sent Events
app.post('/api/scrape', async (req, res) => {
  try {
    const { searchQuery, maxProducts } = req.body;

    // Validate input
    if (!searchQuery || typeof searchQuery !== 'string' || searchQuery.trim() === '') {
      return res.status(400).json({ error: 'searchQuery is required and must be a non-empty string' });
    }

    const maxProductsNum = parseInt(maxProducts, 10);
    if (isNaN(maxProductsNum) || maxProductsNum < 1 || maxProductsNum > 500) {
      return res.status(400).json({ error: 'maxProducts must be a number between 1 and 500' });
    }

    // Set up SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable buffering for nginx

    const sessionId = Date.now().toString();
    const results = [];

    // Send initial connection message
    res.write(`data: ${JSON.stringify({ type: 'connected', sessionId })}\n\n`);

    // Progress callback
    const onProgress = (data) => {
      results.push(data.product);
      res.write(`data: ${JSON.stringify({
        type: 'progress',
        product: data.product,
        progress: data.progress,
        stats: data.stats,
      })}\n\n`);
    };

    // Run scraper with progress callback
    runScraper({
      searchQuery: searchQuery.trim(),
      maxProducts: maxProductsNum,
      headless: true,
    }, onProgress)
      .then(async (result) => {
        // Save to MongoDB
        try {
          const scrapeResult = new ScrapeResult({
            searchQuery: searchQuery.trim(),
            maxProducts: maxProductsNum,
            products: result.results,
            stats: result.stats,
            csvData: result.csv,
            filename: result.filename,
          });
          
          await scrapeResult.save();
          console.log(`Scrape result saved to database with ID: ${scrapeResult._id}`);
        } catch (dbError) {
          console.error('Error saving to database:', dbError);
          // Don't fail the request if DB save fails
        }
        
        // Send completion message
        res.write(`data: ${JSON.stringify({
          type: 'complete',
          results: result.results,
          stats: result.stats,
          csv: result.csv,
          filename: result.filename,
        })}\n\n`);
        res.end();
      })
      .catch((error) => {
        console.error('Scraping error:', error);
        res.write(`data: ${JSON.stringify({
          type: 'error',
          error: error.message || 'An error occurred while scraping',
        })}\n\n`);
        res.end();
      });

    // Handle client disconnect
    req.on('close', () => {
      console.log('Client disconnected');
    });
  } catch (error) {
    console.error('Scraping error:', error);
    res.write(`data: ${JSON.stringify({
      type: 'error',
      error: error.message || 'An error occurred while scraping',
    })}\n\n`);
    res.end();
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Get all scrape results
app.get('/api/scrapes', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const skip = parseInt(req.query.skip) || 0;
    
    const scrapes = await ScrapeResult.find()
      .sort({ createdAt: -1 })
      .limit(limit)
      .skip(skip)
      .select('searchQuery maxProducts stats createdAt _id')
      .lean();
    
    const total = await ScrapeResult.countDocuments();
    
    res.json({
      success: true,
      scrapes,
      total,
      limit,
      skip,
    });
  } catch (error) {
    console.error('Error fetching scrapes:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Get a specific scrape result by ID
app.get('/api/scrapes/:id', async (req, res) => {
  try {
    const scrape = await ScrapeResult.findById(req.params.id);
    
    if (!scrape) {
      return res.status(404).json({
        success: false,
        error: 'Scrape result not found',
      });
    }
    
    res.json({
      success: true,
      scrape,
    });
  } catch (error) {
    console.error('Error fetching scrape:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Delete a scrape result
app.delete('/api/scrapes/:id', async (req, res) => {
  try {
    const scrape = await ScrapeResult.findByIdAndDelete(req.params.id);
    
    if (!scrape) {
      return res.status(404).json({
        success: false,
        error: 'Scrape result not found',
      });
    }
    
    res.json({
      success: true,
      message: 'Scrape result deleted',
    });
  } catch (error) {
    console.error('Error deleting scrape:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Serve frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Function to start server with port retry logic
function startServer(port, attempt = 0) {
  const server = app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
    console.log(`Open your browser and navigate to http://localhost:${port}`);
  });

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      const nextPort = BASE_PORT + attempt + 1;
      if (attempt < MAX_PORT_ATTEMPTS) {
        console.log(`Port ${port} is in use, trying port ${nextPort}...`);
        startServer(nextPort, attempt + 1);
      } else {
        console.error(`Failed to find an available port after ${MAX_PORT_ATTEMPTS} attempts`);
        process.exit(1);
      }
    } else {
      console.error('Server error:', error);
      process.exit(1);
    }
  });
}

// Start the server
startServer(BASE_PORT);

