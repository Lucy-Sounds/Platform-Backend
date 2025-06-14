// This file is explicitly named with .cjs extension to indicate it uses CommonJS
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
// Heroku assigns a dynamic port via process.env.PORT
const PORT = process.env.PORT || process.env.BACKEND_PORT || 3001;

// Initialize Supabase client (with fallbacks for local testing)
const supabaseUrl = process.env.REACT_APP_SUPABASE_URL || 'https://example.supabase.co';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.REACT_APP_SUPABASE_ANON_KEY || 'dummy_key_for_local_testing';
let supabase;

try {
  supabase = createClient(supabaseUrl, supabaseKey);
  console.log('Supabase client initialized');
} catch (error) {
  console.warn('Failed to initialize Supabase client, using mock data:', error.message);
  // Create a mock supabase client with empty methods
  supabase = {
    from: () => ({
      select: () => ({ data: null, error: null }),
      insert: () => ({ data: null, error: null }),
      update: () => ({ data: null, error: null }),
      delete: () => ({ data: null, error: null }),
      eq: () => ({ data: null, error: null }),
      single: () => ({ data: null, error: null })
    }),
    auth: {
      getUser: () => Promise.resolve({ data: { user: null }, error: null }),
      getSession: () => Promise.resolve({ data: { session: null }, error: null })
    }
  };
}

// Middleware
app.use(cors({
  origin: function (origin, callback) {
    const allowedOrigins = process.env.NODE_ENV === 'production' 
      ? ['https://app.lucysounds.com', 'https://api.lucysounds.com', 'https://lucysounds.com', 'https://www.lucysounds.com']
      : ['http://localhost:3000', 'http://localhost:5173'];
    
    // Allow requests with no origin (mobile apps, Postman, etc.)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    } else {
      console.log(`CORS blocked origin: ${origin}`);
      return callback(null, false); // Don't pass an Error to avoid console errors
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-User-ID']
}));

// Additional CORS headers middleware as fallback
app.use((req, res, next) => {
  const allowedOrigins = process.env.NODE_ENV === 'production' 
    ? ['https://app.lucysounds.com', 'https://api.lucysounds.com', 'https://lucysounds.com', 'https://www.lucysounds.com']
    : ['http://localhost:3000', 'http://localhost:5173'];
  
  const origin = req.headers.origin;
  
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-User-ID');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  
  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  
  next();
});

app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({ 
    message: 'Platform Analytics API Server with CORS fixed', 
    status: 'running',
    timestamp: new Date().toISOString()
  });
});

// Analytics endpoints with CORS support
app.get('/api/analytics/spotify/:id', (req, res) => {
  res.json({
    success: true,
    profile: {
      id: req.params.id,
      name: "Artist Name",
      followers: 5000,
      popularity: 75
    },
    topTracks: [
      { name: "Track 1", streams: 1000000 },
      { name: "Track 2", streams: 750000 },
      { name: "Track 3", streams: 500000 }
    ],
    metrics: {
      totalStreams: 5000000,
      avgPopularity: 70,
      monthlyListeners: 250000
    }
  });
});

app.get('/api/analytics/twitter/:username', (req, res) => {
  res.json({
    success: true,
    profile: {
      username: req.params.username,
      followers: 10000,
      following: 500
    },
    metrics: {
      tweets: 5000,
      impressions: 1000000,
      engagementRate: 3.5
    }
  });
});

app.get('/api/analytics/youtube/:channelId', (req, res) => {
  res.json({
    success: true,
    channel: {
      id: req.params.channelId,
      name: "Channel Name",
      subscribers: 50000,
      videoCount: 100
    },
    metrics: {
      totalViews: 5000000,
      avgViewsPerVideo: 50000,
      watchTime: 250000
    }
  });
});

app.get('/api/analytics/soundcloud/:username', (req, res) => {
  res.json({
    success: true,
    profile: {
      username: req.params.username,
      followers: 8000
    },
    metrics: {
      tracks: 50,
      plays: 500000,
      likes: 25000
    }
  });
});

app.get('/api/analytics/instagram/:username', (req, res) => {
  res.json({
    success: true,
    profile: {
      username: req.params.username,
      followers: 15000,
      following: 1000
    },
    metrics: {
      posts: 200,
      avgLikes: 1500,
      engagementRate: 10
    }
  });
});

// Start the server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT} with CORS enabled`);
  console.log(`Access the server at http://localhost:${PORT}/health`);
}); 