const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
// Heroku assigns a dynamic port via process.env.PORT
const PORT = process.env.PORT || process.env.BACKEND_PORT || 3001;

// Initialize Supabase client
const supabase = createClient(
  process.env.REACT_APP_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.REACT_APP_SUPABASE_ANON_KEY
);

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
      return callback(new Error('Not allowed by CORS'), false);
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
  
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-User-ID');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  
  next();
});

app.use(express.json());

// Add a root endpoint for Heroku health checks
app.get('/', (req, res) => {
  res.json({ 
    message: 'Platform Analytics API Server', 
    status: 'running',
    timestamp: new Date().toISOString(),
    endpoints: {
      health: '/health',
      spotify: '/api/spotify/*',
      youtube: '/api/youtube/*',
      facebook: '/api/facebook/*',
      instagram: '/api/instagram/*',
      twitter: '/api/twitter/*',
      tiktok: '/api/tiktok/*',
      googleAnalytics: '/api/google-analytics/*',
      ai: '/api/ai/*',
      platforms: '/api/platforms/*',
      auth: '/api/auth/callback/*'
    }
  });
});

// Helper function to get user's OAuth token
async function getUserOAuthToken(userId, platform) {
  try {
    // Get all tokens for this user/platform, ordered by most recent first
    const { data, error } = await supabase
      .from('oauth_tokens')
      .select('access_token, refresh_token, expires_at, updated_at')
      .eq('user_id', userId)
      .eq('platform_id', platform)
      .order('updated_at', { ascending: false });

    if (error) {
      console.error(`Error querying OAuth tokens for ${platform}:`, error);
      return null;
    }

    if (!data || data.length === 0) {
      console.log(`No OAuth token found for user ${userId} on ${platform}`);
      return null;
    }

    // If we have multiple tokens, clean up duplicates (keep the most recent one)
    if (data.length > 1) {
      console.log(`Found ${data.length} duplicate tokens for user ${userId} on ${platform}, cleaning up...`);
      
      // Keep the first (most recent) token, delete the rest
      const tokensToDelete = data.slice(1);
      for (const token of tokensToDelete) {
        try {
          await supabase
            .from('oauth_tokens')
            .delete()
            .eq('user_id', userId)
            .eq('platform_id', platform)
            .eq('updated_at', token.updated_at);
        } catch (deleteError) {
          console.error(`Error deleting duplicate token:`, deleteError);
        }
      }
      console.log(`✅ Cleaned up ${tokensToDelete.length} duplicate tokens for ${platform}`);
    }

    const tokenData = data[0]; // Use the most recent token

    // Check if token is expired and needs refresh
    if (tokenData.expires_at && new Date(tokenData.expires_at) < new Date()) {
      console.log(`Token expired for ${platform}, needs refresh`);
      // TODO: Implement token refresh logic
      return null;
    }

    return tokenData.access_token;
  } catch (error) {
    console.error(`Error getting OAuth token for ${platform}:`, error);
    return null;
  }
}

// Helper function to get platform configuration
async function getPlatformConfig(platform) {
  try {
    // Try new table first
    const { data: newData, error: newError } = await supabase
      .from('platform_oauth_configs')
      .select('*')
      .eq('platform_id', platform)
      .eq('enabled', true)
      .single();

    if (!newError && newData) {
      return {
        clientId: newData.client_id,
        clientSecret: newData.client_secret,
        redirectUri: newData.redirect_uri,
        scopes: newData.scopes,
        apiEndpoint: newData.api_endpoint
      };
    }

    // Fallback to old table
    const { data: oldData, error: oldError } = await supabase
      .from('platform_settings')
      .select('*')
      .eq('platform_id', platform)
      .eq('enabled', true)
      .single();

    if (!oldError && oldData) {
      return {
        clientId: oldData.client_id || oldData.setting_value?.clientId,
        clientSecret: oldData.client_secret || oldData.setting_value?.clientSecret,
        redirectUri: oldData.redirect_uri || oldData.setting_value?.redirectUri,
        scopes: oldData.scopes || oldData.setting_value?.scopes,
        apiEndpoint: oldData.api_endpoint || oldData.setting_value?.apiEndpoint
      };
    }

    return null;
  } catch (error) {
    console.error(`Error getting platform config for ${platform}:`, error);
    return null;
  }
}

// Middleware to extract user ID from request
async function extractUserId(req, res, next) {
  try {
    // Get the Authorization header
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No authorization token provided' });
    }

    const token = authHeader.substring(7); // Remove 'Bearer ' prefix

    // Verify the JWT token with Supabase
    const { data: { user }, error } = await supabase.auth.getUser(token);
    
    if (error || !user) {
      console.error('Auth error:', error);
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    req.userId = user.id;
    req.user = user;
    next();
  } catch (error) {
    console.error('Error extracting user ID:', error);
    res.status(401).json({ error: 'Authentication failed' });
  }
}

// ==================== SPOTIFY ENDPOINTS ====================

app.get('/api/spotify/me', extractUserId, async (req, res) => {
  try {
    const token = await getUserOAuthToken(req.userId, 'spotify');
    if (!token) {
      return res.status(401).json({ error: 'No Spotify token found' });
    }

    const response = await axios.get('https://api.spotify.com/v1/me', {
      headers: { Authorization: `Bearer ${token}` }
    });

    res.json(response.data);
  } catch (error) {
    console.error('Spotify /me error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch Spotify profile' });
  }
});

app.get('/api/spotify/top-tracks', extractUserId, async (req, res) => {
  try {
    const token = await getUserOAuthToken(req.userId, 'spotify');
    if (!token) {
      return res.status(401).json({ error: 'No Spotify token found' });
    }

    const { time_range = 'medium_term', limit = 50 } = req.query;
    const response = await axios.get(`https://api.spotify.com/v1/me/top/tracks`, {
      headers: { Authorization: `Bearer ${token}` },
      params: { time_range, limit }
    });

    res.json(response.data);
  } catch (error) {
    console.error('Spotify top tracks error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch top tracks' });
  }
});

app.get('/api/spotify/recently-played', extractUserId, async (req, res) => {
  try {
    const token = await getUserOAuthToken(req.userId, 'spotify');
    if (!token) {
      return res.status(401).json({ error: 'No Spotify token found' });
    }

    const { limit = 50 } = req.query;
    const response = await axios.get(`https://api.spotify.com/v1/me/player/recently-played`, {
      headers: { Authorization: `Bearer ${token}` },
      params: { limit }
    });

    res.json(response.data);
  } catch (error) {
    console.error('Spotify recently played error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch recently played' });
  }
});

app.get('/api/spotify/playlists', extractUserId, async (req, res) => {
  try {
    const token = await getUserOAuthToken(req.userId, 'spotify');
    if (!token) {
      return res.status(401).json({ error: 'No Spotify token found' });
    }

    const { limit = 50 } = req.query;
    const response = await axios.get(`https://api.spotify.com/v1/me/playlists`, {
      headers: { Authorization: `Bearer ${token}` },
      params: { limit }
    });

    res.json(response.data);
  } catch (error) {
    console.error('Spotify playlists error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch playlists' });
  }
});

// ==================== SPOTIFY ARTIST ENDPOINTS (PUBLIC API) ====================

// Get Spotify Client Credentials token for public API access
async function getSpotifyClientToken() {
  try {
    const config = await getPlatformConfig('spotify');
    if (!config || !config.clientId || !config.clientSecret) {
      console.log('No Spotify client credentials configured');
      return null;
    }

    const response = await axios.post('https://accounts.spotify.com/api/token', 
      'grant_type=client_credentials',
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': 'Basic ' + Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')
        }
      }
    );

    return response.data.access_token;
  } catch (error) {
    console.error('Failed to get Spotify client token:', error.response?.data || error.message);
    return null;
  }
}

// Public Spotify artist endpoint (no authentication required)
app.get('/api/spotify/artist/:id/public', async (req, res) => {
  try {
    const { id } = req.params;
    const token = await getSpotifyClientToken();
    
    if (!token) {
      return res.status(503).json({ 
        error: 'Spotify API not available', 
        message: 'Spotify client credentials not configured. Please check backend environment variables.',
        savedToDatabase: false
      });
    }

    console.log(`🎵 Fetching public artist data for ID: ${id}`);

    // Fetch all artist data in parallel for better performance
    const [artistResponse, albumsResponse, topTracksResponse] = await Promise.all([
      // Get artist profile
      axios.get(`https://api.spotify.com/v1/artists/${id}`, {
        headers: { Authorization: `Bearer ${token}` }
      }),
      
      // Get artist's albums and singles
      axios.get(`https://api.spotify.com/v1/artists/${id}/albums`, {
        headers: { Authorization: `Bearer ${token}` },
        params: { 
          limit: 20, 
          include_groups: 'album,single',
          market: 'US'
        }
      }),
      
      // Get artist's top tracks
      axios.get(`https://api.spotify.com/v1/artists/${id}/top-tracks`, {
        headers: { Authorization: `Bearer ${token}` },
        params: { market: 'US' }
      })
    ]);

    const artist = artistResponse.data;
    const albums = albumsResponse.data;
    const topTracks = topTracksResponse.data;

    console.log(`✅ Successfully fetched public artist data: ${artist.name} (${artist.followers?.total || 0} followers)`);

    // Return comprehensive artist data without requiring authentication
    res.json({
      ...artist,
      albums: albums.items || [],
      topTracks: topTracks.tracks || [],
      totalAlbums: albums.total || albums.items?.length || 0,
      totalSingles: albums.items?.filter(album => album.album_type === 'single').length || 0,
      savedToDatabase: false // No user authentication, so not saved to database
    });

  } catch (error) {
    console.error('Spotify artist API error:', error.response?.data || error.message);
    
    if (error.response?.status === 404) {
      res.status(404).json({ 
        error: 'Artist not found',
        message: 'The requested Spotify artist could not be found.',
        savedToDatabase: false
      });
    } else if (error.response?.status === 400) {
      res.status(400).json({ 
        error: 'Invalid artist ID',
        message: 'The provided artist ID is not valid.',
        savedToDatabase: false
      });
    } else {
      res.status(500).json({ 
        error: 'Spotify API error',
        message: 'Failed to fetch artist data. Please try again later.',
        savedToDatabase: false
      });
    }
  }
});

// Authenticated Spotify artist endpoint (saves to user database)
app.get('/api/spotify/artist/:id', extractUserId, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.userId; // From extractUserId middleware
    const token = await getSpotifyClientToken();
    
    if (!token) {
      return res.status(503).json({ 
        error: 'Spotify API not available', 
        message: 'Spotify client credentials not configured. Please check backend environment variables.',
        savedToDatabase: false
      });
    }

    console.log(`🎵 Fetching comprehensive artist data for ID: ${id} (User: ${userId})`);

    // Fetch all artist data in parallel for better performance
    const [artistResponse, albumsResponse, topTracksResponse] = await Promise.all([
      // Get artist profile
      axios.get(`https://api.spotify.com/v1/artists/${id}`, {
        headers: { Authorization: `Bearer ${token}` }
      }),
      
      // Get artist's albums and singles
      axios.get(`https://api.spotify.com/v1/artists/${id}/albums`, {
        headers: { Authorization: `Bearer ${token}` },
        params: { 
          limit: 20, 
          include_groups: 'album,single',
          market: 'US'
        }
      }),
      
      // Get artist's top tracks
      axios.get(`https://api.spotify.com/v1/artists/${id}/top-tracks`, {
        headers: { Authorization: `Bearer ${token}` },
        params: { market: 'US' }
      })
    ]);

    const artist = artistResponse.data;
    const albums = albumsResponse.data;
    const topTracks = topTracksResponse.data;

    // 💾 Save artist connection to database
    let savedToDatabase = false;
    try {
      const { data: existingConnection, error: checkError } = await supabase
        .from('user_artist_connections')
        .select('*')
        .eq('user_id', userId)
        .eq('artist_id', id)
        .eq('platform', 'spotify')
        .single();

      if (checkError && checkError.code !== 'PGRST116') {
        console.error('Error checking existing artist connection:', checkError);
      }

      // Create or update artist connection
      const connectionData = {
        user_id: userId,
        artist_id: id,
        platform: 'spotify',
        artist_name: artist.name,
        artist_image: artist.images?.[0]?.url || null,
        followers_count: artist.followers?.total || 0,
        popularity: artist.popularity || 0,
        genres: artist.genres || [],
        last_accessed: new Date().toISOString(),
        connection_metadata: {
          totalAlbums: albums.total || albums.items?.length || 0,
          totalSingles: albums.items?.filter(album => album.album_type === 'single').length || 0,
          topTrackCount: topTracks.tracks?.length || 0
        }
      };

      if (existingConnection) {
        // Update existing connection
        const { error: updateError } = await supabase
          .from('user_artist_connections')
          .update(connectionData)
          .eq('user_id', userId)
          .eq('artist_id', id)
          .eq('platform', 'spotify');

        if (updateError) {
          console.error('Error updating artist connection:', updateError);
        } else {
          console.log(`✅ Updated artist connection: ${artist.name} (${id}) for user ${userId}`);
          savedToDatabase = true;
        }
      } else {
        // Create new connection
        connectionData.created_at = new Date().toISOString();
        const { error: insertError } = await supabase
          .from('user_artist_connections')
          .insert(connectionData);

        if (insertError) {
          console.error('Error saving artist connection:', insertError);
        } else {
          console.log(`✅ Saved new artist connection: ${artist.name} (${id}) for user ${userId}`);
          savedToDatabase = true;
        }
      }
    } catch (dbError) {
      console.error('Database operation failed:', dbError);
      // Continue with API response even if database save fails
    }

    console.log(`✅ Successfully fetched artist data: ${artist.name} (${artist.followers?.total || 0} followers) - DB saved: ${savedToDatabase}`);

    // Return comprehensive artist data
    res.json({
      ...artist,
      albums: albums.items || [],
      topTracks: topTracks.tracks || [],
      totalAlbums: albums.total || albums.items?.length || 0,
      totalSingles: albums.items?.filter(album => album.album_type === 'single').length || 0,
      savedToDatabase
    });

  } catch (error) {
    console.error('Spotify artist API error:', error.response?.data || error.message);
    
    if (error.response?.status === 404) {
      res.status(404).json({ 
        error: 'Artist not found',
        message: 'The requested Spotify artist could not be found.',
        savedToDatabase: false
      });
    } else if (error.response?.status === 400) {
      res.status(400).json({ 
        error: 'Invalid artist ID',
        message: 'The provided artist ID is not valid.',
        savedToDatabase: false
      });
    } else {
      res.status(500).json({ 
        error: 'Spotify API error',
        message: 'Failed to fetch artist data. Please try again later.',
        savedToDatabase: false
      });
    }
  }
});

app.get('/api/spotify/artist/:id/albums', async (req, res) => {
  try {
    const { id } = req.params;
    const { limit = 50 } = req.query;
    const token = await getSpotifyClientToken();
    
    if (!token) {
      return res.status(503).json({ error: 'Spotify API not available' });
    }

    const response = await axios.get(`https://api.spotify.com/v1/artists/${id}/albums`, {
      headers: { Authorization: `Bearer ${token}` },
      params: { limit, include_groups: 'album,single' }
    });

    res.json(response.data);
  } catch (error) {
    console.error('Spotify artist albums error:', error.response?.data || error.message);
    if (error.response?.status === 404) {
      res.status(404).json({ error: 'Artist not found' });
    } else {
      res.status(500).json({ error: 'Failed to fetch artist albums' });
    }
  }
});

app.get('/api/spotify/artist/:id/top-tracks', async (req, res) => {
  try {
    const { id } = req.params;
    const { market = 'US' } = req.query;
    const token = await getSpotifyClientToken();
    
    if (!token) {
      return res.status(503).json({ error: 'Spotify API not available' });
    }

    const response = await axios.get(`https://api.spotify.com/v1/artists/${id}/top-tracks`, {
      headers: { Authorization: `Bearer ${token}` },
      params: { market }
    });

    res.json(response.data);
  } catch (error) {
    console.error('Spotify artist top tracks error:', error.response?.data || error.message);
    if (error.response?.status === 404) {
      res.status(404).json({ error: 'Artist not found' });
    } else {
      res.status(500).json({ error: 'Failed to fetch artist top tracks' });
    }
  }
});

// ==================== YOUTUBE ENDPOINTS ====================

app.get('/api/youtube/channel', extractUserId, async (req, res) => {
  try {
    const token = await getUserOAuthToken(req.userId, 'youtube');
    if (!token) {
      return res.status(401).json({ error: 'No YouTube token found' });
    }

    const response = await axios.get('https://www.googleapis.com/youtube/v3/channels', {
      headers: { Authorization: `Bearer ${token}` },
      params: {
        part: 'snippet,statistics',
        mine: true
      }
    });

    res.json(response.data.items?.[0] || {});
  } catch (error) {
    console.error('YouTube channel error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch YouTube channel' });
  }
});

app.get('/api/youtube/videos', extractUserId, async (req, res) => {
  try {
    const token = await getUserOAuthToken(req.userId, 'youtube');
    if (!token) {
      return res.status(401).json({ error: 'No YouTube token found' });
    }

    const { maxResults = 50 } = req.query;
    
    // First get the channel ID
    const channelResponse = await axios.get('https://www.googleapis.com/youtube/v3/channels', {
      headers: { Authorization: `Bearer ${token}` },
      params: { part: 'id', mine: true }
    });

    const channelId = channelResponse.data.items?.[0]?.id;
    if (!channelId) {
      return res.status(404).json({ error: 'No YouTube channel found' });
    }

    // Get videos from the channel
    const videosResponse = await axios.get('https://www.googleapis.com/youtube/v3/search', {
      headers: { Authorization: `Bearer ${token}` },
      params: {
        part: 'snippet',
        channelId,
        maxResults,
        order: 'date',
        type: 'video'
      }
    });

    // Get video statistics
    const videoIds = videosResponse.data.items?.map(item => item.id.videoId).join(',');
    if (videoIds) {
      const statsResponse = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
        headers: { Authorization: `Bearer ${token}` },
        params: {
          part: 'statistics',
          id: videoIds
        }
      });

      // Merge statistics with video data
      const videosWithStats = videosResponse.data.items?.map(video => {
        const stats = statsResponse.data.items?.find(stat => stat.id === video.id.videoId);
        return {
          id: video.id.videoId,
          content: video.snippet.title,
          description: video.snippet.description,
          author: video.snippet.channelTitle || 'Your Channel',
          thumbnail_url: video.snippet.thumbnails?.medium?.url,
          created_at: video.snippet.publishedAt,
          likes_count: parseInt(stats?.statistics?.likeCount) || 0,
          comments_count: parseInt(stats?.statistics?.commentCount) || 0,
          views_count: parseInt(stats?.statistics?.viewCount) || 0,
          permalink: `https://www.youtube.com/watch?v=${video.id.videoId}`,
          platform: 'youtube'
        };
      });

      res.json({ items: videosWithStats });
    } else {
      res.json({ items: [] });
    }
  } catch (error) {
    console.error('YouTube videos error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch YouTube videos' });
  }
});

app.get('/api/youtube/analytics', extractUserId, async (req, res) => {
  try {
    const token = await getUserOAuthToken(req.userId, 'youtube');
    if (!token) {
      return res.status(401).json({ error: 'No YouTube token found' });
    }

    const { timeRange = '7d' } = req.query;
    
    // Convert timeRange to YouTube Analytics format
    const endDate = new Date().toISOString().split('T')[0];
    const startDate = new Date(Date.now() - (parseInt(timeRange) * 24 * 60 * 60 * 1000)).toISOString().split('T')[0];

    const response = await axios.get('https://youtubeanalytics.googleapis.com/v2/reports', {
      headers: { Authorization: `Bearer ${token}` },
      params: {
        ids: 'channel==MINE',
        startDate,
        endDate,
        metrics: 'views,estimatedMinutesWatched,subscribersGained',
        dimensions: 'day'
      }
    });

    res.json({
      views: response.data.rows?.reduce((sum, row) => sum + row[1], 0) || 0,
      watchTime: response.data.rows?.reduce((sum, row) => sum + row[2], 0) || 0,
      subscribers: response.data.rows?.reduce((sum, row) => sum + row[3], 0) || 0
    });
  } catch (error) {
    console.error('YouTube analytics error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch YouTube analytics' });
  }
});

// ==================== FACEBOOK ENDPOINTS ====================

app.get('/api/facebook/page', extractUserId, async (req, res) => {
  try {
    const token = await getUserOAuthToken(req.userId, 'facebook');
    if (!token) {
      return res.status(401).json({ error: 'No Facebook token found' });
    }

    const response = await axios.get('https://graph.facebook.com/v18.0/me/accounts', {
      params: {
        access_token: token,
        fields: 'id,name,fan_count,followers_count,category'
      }
    });

    // Return the first page or user profile
    res.json(response.data.data?.[0] || {});
  } catch (error) {
    console.error('Facebook page error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch Facebook page' });
  }
});

app.get('/api/facebook/posts', extractUserId, async (req, res) => {
  try {
    const token = await getUserOAuthToken(req.userId, 'facebook');
    if (!token) {
      return res.status(401).json({ error: 'No Facebook token found' });
    }

    const { limit = 50 } = req.query;
    const response = await axios.get('https://graph.facebook.com/v18.0/me/posts', {
      params: {
        access_token: token,
        fields: 'id,message,created_time,likes.summary(true),comments.summary(true),shares',
        limit
      }
    });

    res.json(response.data);
  } catch (error) {
    console.error('Facebook posts error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch Facebook posts' });
  }
});

app.get('/api/facebook/insights', extractUserId, async (req, res) => {
  try {
    const token = await getUserOAuthToken(req.userId, 'facebook');
    if (!token) {
      return res.status(401).json({ error: 'No Facebook token found' });
    }

    // This would require page-level insights which need page access tokens
    // For now, return mock data
    res.json({
      reach: 0,
      impressions: 0,
      engagement: 0,
      clicks: 0
    });
  } catch (error) {
    console.error('Facebook insights error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch Facebook insights' });
  }
});

// ==================== INSTAGRAM ENDPOINTS ====================

app.get('/api/instagram/profile', extractUserId, async (req, res) => {
  try {
    const token = await getUserOAuthToken(req.userId, 'instagram');
    if (!token) {
      return res.status(401).json({ error: 'No Instagram token found' });
    }

    const response = await axios.get('https://graph.instagram.com/me', {
      params: {
        access_token: token,
        fields: 'id,username,followers_count,follows_count,media_count'
      }
    });

    res.json(response.data);
  } catch (error) {
    console.error('Instagram profile error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch Instagram profile' });
  }
});

app.get('/api/instagram/media', extractUserId, async (req, res) => {
  try {
    const token = await getUserOAuthToken(req.userId, 'instagram');
    if (!token) {
      return res.status(401).json({ error: 'No Instagram token found' });
    }

    const { limit = 50 } = req.query;
    const response = await axios.get('https://graph.instagram.com/me/media', {
      params: {
        access_token: token,
        fields: 'id,caption,media_type,media_url,timestamp,like_count,comments_count',
        limit
      }
    });

    res.json(response.data);
  } catch (error) {
    console.error('Instagram media error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch Instagram media' });
  }
});

app.get('/api/instagram/insights', extractUserId, async (req, res) => {
  try {
    const token = await getUserOAuthToken(req.userId, 'instagram');
    if (!token) {
      return res.status(401).json({ error: 'No Instagram token found' });
    }

    // Instagram insights require business accounts and specific permissions
    // For now, return mock data
    res.json({
      reach: 0,
      impressions: 0,
      engagement: 0,
      saves: 0
    });
  } catch (error) {
    console.error('Instagram insights error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch Instagram insights' });
  }
});

// ==================== TWITTER ENDPOINTS ====================

app.get('/api/twitter/profile', extractUserId, async (req, res) => {
  try {
    const token = await getUserOAuthToken(req.userId, 'twitter');
    if (!token) {
      return res.status(401).json({ error: 'No Twitter token found' });
    }

    const response = await axios.get('https://api.twitter.com/2/users/me', {
      headers: { Authorization: `Bearer ${token}` },
      params: {
        'user.fields': 'public_metrics,verified'
      }
    });

    res.json(response.data.data);
  } catch (error) {
    console.error('Twitter profile error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch Twitter profile' });
  }
});

app.get('/api/twitter/tweets', extractUserId, async (req, res) => {
  try {
    const token = await getUserOAuthToken(req.userId, 'twitter');
    if (!token) {
      return res.status(401).json({ error: 'No Twitter token found' });
    }

    const { max_results = 100 } = req.query;
    const response = await axios.get('https://api.twitter.com/2/users/me/tweets', {
      headers: { Authorization: `Bearer ${token}` },
      params: {
        max_results,
        'tweet.fields': 'public_metrics,created_at'
      }
    });

    res.json(response.data);
  } catch (error) {
    console.error('Twitter tweets error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch Twitter tweets' });
  }
});

app.get('/api/twitter/metrics', extractUserId, async (req, res) => {
  try {
    const token = await getUserOAuthToken(req.userId, 'twitter');
    if (!token) {
      return res.status(401).json({ error: 'No Twitter token found' });
    }

    // Twitter API v2 doesn't provide direct analytics for regular users
    // This would require Twitter API v1.1 or business account
    res.json({
      impressions: 0,
      engagement: 0,
      clicks: 0,
      mentions: 0
    });
  } catch (error) {
    console.error('Twitter metrics error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch Twitter metrics' });
  }
});

// ==================== TIKTOK ENDPOINTS ====================

app.get('/api/tiktok/profile', extractUserId, async (req, res) => {
  try {
    const token = await getUserOAuthToken(req.userId, 'tiktok');
    if (!token) {
      return res.status(401).json({ error: 'No TikTok token found' });
    }

    const response = await axios.get('https://open-api.tiktok.com/user/info/', {
      headers: { Authorization: `Bearer ${token}` },
      params: {
        fields: 'open_id,display_name,follower_count,following_count,likes_count,video_count'
      }
    });

    res.json(response.data.data);
  } catch (error) {
    console.error('TikTok profile error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch TikTok profile' });
  }
});

app.get('/api/tiktok/videos', extractUserId, async (req, res) => {
  try {
    const token = await getUserOAuthToken(req.userId, 'tiktok');
    if (!token) {
      return res.status(401).json({ error: 'No TikTok token found' });
    }

    const { max_count = 50 } = req.query;
    const response = await axios.get('https://open-api.tiktok.com/video/list/', {
      headers: { Authorization: `Bearer ${token}` },
      params: {
        max_count,
        fields: 'id,title,create_time,duration,view_count,like_count,comment_count,share_count'
      }
    });

    res.json(response.data);
  } catch (error) {
    console.error('TikTok videos error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch TikTok videos' });
  }
});

app.get('/api/tiktok/analytics', extractUserId, async (req, res) => {
  try {
    const token = await getUserOAuthToken(req.userId, 'tiktok');
    if (!token) {
      return res.status(401).json({ error: 'No TikTok token found' });
    }

    // TikTok analytics would require specific business API access
    res.json({
      video_views: 0,
      likes: 0,
      shares: 0,
      comments: 0
    });
  } catch (error) {
    console.error('TikTok analytics error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch TikTok analytics' });
  }
});

// ==================== GOOGLE ANALYTICS ENDPOINTS ====================

app.get('/api/google-analytics/overview', extractUserId, async (req, res) => {
  try {
    const token = await getUserOAuthToken(req.userId, 'google_analytics');
    if (!token) {
      return res.status(401).json({ error: 'No Google Analytics token found' });
    }

    // This would require Google Analytics Reporting API v4
    // For now, return mock data
    res.json({
      sessions: 0,
      users: 0,
      pageviews: 0,
      bounceRate: 0
    });
  } catch (error) {
    console.error('Google Analytics overview error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch Google Analytics overview' });
  }
});

app.get('/api/google-analytics/traffic', extractUserId, async (req, res) => {
  try {
    const token = await getUserOAuthToken(req.userId, 'google_analytics');
    if (!token) {
      return res.status(401).json({ error: 'No Google Analytics token found' });
    }

    res.json({
      organic: 0,
      direct: 0,
      referral: 0,
      social: 0
    });
  } catch (error) {
    console.error('Google Analytics traffic error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch Google Analytics traffic' });
  }
});

app.get('/api/google-analytics/demographics', extractUserId, async (req, res) => {
  try {
    const token = await getUserOAuthToken(req.userId, 'google_analytics');
    if (!token) {
      return res.status(401).json({ error: 'No Google Analytics token found' });
    }

    res.json({
      countries: [],
      ageGroups: [],
      devices: []
    });
  } catch (error) {
    console.error('Google Analytics demographics error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch Google Analytics demographics' });
  }
});

app.get('/api/google-analytics/behavior', extractUserId, async (req, res) => {
  try {
    const token = await getUserOAuthToken(req.userId, 'google_analytics');
    if (!token) {
      return res.status(401).json({ error: 'No Google Analytics token found' });
    }

    res.json({
      topPages: [],
      avgSessionDuration: 0,
      pagesPerSession: 0
    });
  } catch (error) {
    console.error('Google Analytics behavior error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch Google Analytics behavior' });
  }
});

// ==================== PROPERTY MANAGEMENT ENDPOINTS ====================

// Get platform properties for a user
app.get('/api/platforms/:platform/properties/:userId', async (req, res) => {
  try {
    const { platform, userId } = req.params;
    
    console.log(`📋 Fetching ${platform} properties for user: ${userId}`);
    
    // Get OAuth token for the platform
    const token = await getUserOAuthToken(userId, platform);
    if (!token) {
      return res.status(401).json({ error: `No ${platform} token found for user` });
    }

    let properties = [];

    try {
      switch (platform) {
        case 'google_analytics':
          // Fetch Google Analytics properties
          const gaResponse = await axios.get('https://analyticsadmin.googleapis.com/v1beta/accounts', {
            headers: { Authorization: `Bearer ${token}` }
          });
          
          if (gaResponse.data.accounts) {
            // For each account, get properties
            for (const account of gaResponse.data.accounts) {
              const propertiesResponse = await axios.get(`https://analyticsadmin.googleapis.com/v1beta/${account.name}/properties`, {
                headers: { Authorization: `Bearer ${token}` }
              });
              
              if (propertiesResponse.data.properties) {
                properties.push(...propertiesResponse.data.properties.map(prop => ({
                  id: prop.name.split('/').pop(),
                  name: prop.displayName,
                  displayName: prop.displayName,
                  websiteUrl: prop.websiteUrl || '',
                  timeZone: prop.timeZone || 'UTC',
                  industryCategory: prop.industryCategory || 'OTHER',
                  dataRetentionTtl: prop.dataRetentionSettings?.eventDataRetention || '26_MONTHS'
                })));
              }
            }
          }
          break;

        case 'facebook':
          // Fetch Facebook pages
          const fbResponse = await axios.get('https://graph.facebook.com/v18.0/me/accounts', {
            headers: { Authorization: `Bearer ${token}` },
            params: { fields: 'id,name,category,website,fan_count' }
          });
          
          if (fbResponse.data.data) {
            properties = fbResponse.data.data.map(page => ({
              id: page.id,
              name: page.name,
              displayName: page.name,
              websiteUrl: page.website || '',
              category: page.category || 'Business',
              followerCount: page.fan_count || 0
            }));
          }
          break;

        case 'instagram':
          // Fetch Instagram business accounts
          const igResponse = await axios.get('https://graph.facebook.com/v18.0/me/accounts', {
            headers: { Authorization: `Bearer ${token}` },
            params: { fields: 'id,name,instagram_business_account' }
          });
          
          if (igResponse.data.data) {
            for (const page of igResponse.data.data) {
              if (page.instagram_business_account) {
                const igAccountResponse = await axios.get(`https://graph.facebook.com/v18.0/${page.instagram_business_account.id}`, {
                  headers: { Authorization: `Bearer ${token}` },
                  params: { fields: 'id,username,name,website,followers_count,account_type' }
                });
                
                if (igAccountResponse.data) {
                  const account = igAccountResponse.data;
                  properties.push({
                    id: account.id,
                    name: account.username,
                    displayName: `@${account.username}`,
                    websiteUrl: account.website || '',
                    accountType: account.account_type || 'business',
                    followerCount: account.followers_count || 0
                  });
                }
              }
            }
          }
          break;

        default:
          return res.status(400).json({ error: `Platform ${platform} not supported for property management` });
      }

      console.log(`✅ Found ${properties.length} properties for ${platform}`);
      res.json({ properties });

    } catch (apiError) {
      console.error(`❌ Error fetching ${platform} properties from API:`, apiError.response?.data || apiError.message);
      
      // Return mock data as fallback
      const mockProperties = getMockProperties(platform);
      console.log(`💾 Returning ${mockProperties.length} mock properties for ${platform}`);
      res.json({ properties: mockProperties });
    }

  } catch (error) {
    console.error(`❌ Error in ${platform} properties endpoint:`, error);
    res.status(500).json({ error: `Failed to fetch ${platform} properties` });
  }
});

// Save selected properties for a user
app.post('/api/platforms/:platform/properties/:userId', async (req, res) => {
  try {
    const { platform, userId } = req.params;
    const { selectedProperties } = req.body;
    
    console.log(`💾 Saving ${platform} property selection for user ${userId}:`, selectedProperties);
    
    // Store selected properties in database
    const { data, error } = await supabase
      .from('user_platform_properties')
      .upsert({
        user_id: userId,
        platform_id: platform,
        selected_properties: selectedProperties,
        updated_at: new Date().toISOString()
      });

    if (error) {
      console.error('Error saving property selection:', error);
      return res.status(500).json({ error: 'Failed to save property selection' });
    }

    console.log(`✅ Saved property selection for ${platform}`);
    res.json({ success: true, selectedProperties });

  } catch (error) {
    console.error('Error in save properties endpoint:', error);
    res.status(500).json({ error: 'Failed to save property selection' });
  }
});

// Get selected properties for a user
app.get('/api/platforms/:platform/properties/:userId/selected', async (req, res) => {
  try {
    const { platform, userId } = req.params;
    
    console.log(`📋 Loading selected ${platform} properties for user: ${userId}`);
    
    const { data, error } = await supabase
      .from('user_platform_properties')
      .select('selected_properties')
      .eq('user_id', userId)
      .eq('platform_id', platform)
      .single();

    if (error && error.code !== 'PGRST116') {
      console.error('Error loading selected properties:', error);
      return res.status(500).json({ error: 'Failed to load selected properties' });
    }

    const selectedProperties = data?.selected_properties || [];
    console.log(`✅ Loaded ${selectedProperties.length} selected properties for ${platform}`);
    
    res.json({ selectedProperties });

  } catch (error) {
    console.error('Error in get selected properties endpoint:', error);
    res.status(500).json({ error: 'Failed to load selected properties' });
  }
});

// ==================== ENHANCED ANALYTICS ENDPOINTS ====================

// Enhanced analytics with property selection
app.post('/api/analytics/:platformId', async (req, res) => {
  try {
    const { platformId } = req.params;
    const { userId, timeRange, selectedProperties } = req.body;
    
    console.log(`📊 Fetching enhanced ${platformId} analytics for user: ${userId}`);
    console.log(`⚙️ Selected properties:`, selectedProperties);
    console.log(`📅 Time range: ${timeRange}`);
    
    // Get OAuth token for the platform
    const token = await getUserOAuthToken(userId, platformId);
    if (!token) {
      return res.status(401).json({ error: `No ${platformId} token found for user` });
    }

    let analyticsData = {};

    try {
      switch (platformId) {
        case 'google_analytics':
          analyticsData = await getEnhancedGoogleAnalytics(token, timeRange, selectedProperties);
          break;
        case 'facebook':
          analyticsData = await getEnhancedFacebookAnalytics(token, timeRange, selectedProperties);
          break;
        case 'instagram':
          analyticsData = await getEnhancedInstagramAnalytics(token, timeRange, selectedProperties);
          break;
        case 'youtube':
          analyticsData = await getEnhancedYouTubeAnalytics(token, timeRange, selectedProperties);
          break;
        case 'spotify':
          analyticsData = await getEnhancedSpotifyAnalytics(token, timeRange, selectedProperties);
          break;
        default:
          return res.status(400).json({ error: `Enhanced analytics not supported for ${platformId}` });
      }

      console.log(`✅ Successfully fetched enhanced ${platformId} analytics`);
      res.json(analyticsData);

    } catch (apiError) {
      console.error(`❌ Error fetching enhanced ${platformId} analytics:`, apiError.response?.data || apiError.message);
      res.status(500).json({ error: `Failed to fetch enhanced ${platformId} analytics` });
    }

  } catch (error) {
    console.error(`❌ Error in enhanced analytics endpoint:`, error);
    res.status(500).json({ error: 'Failed to fetch enhanced analytics' });
  }
});

// Helper function to get mock properties
function getMockProperties(platform) {
  switch (platform) {
    case 'google_analytics':
      return [
        {
          id: 'GA_PROPERTY_123456789',
          name: 'Main Website',
          displayName: 'Main Website Analytics',
          websiteUrl: 'https://example.com',
          timeZone: 'America/New_York',
          industryCategory: 'Technology',
          dataRetentionTtl: '26_MONTHS'
        },
        {
          id: 'GA_PROPERTY_987654321',
          name: 'E-commerce Store',
          displayName: 'Online Store Analytics',
          websiteUrl: 'https://store.example.com',
          timeZone: 'America/Los_Angeles',
          industryCategory: 'Retail',
          dataRetentionTtl: '26_MONTHS'
        }
      ];
    case 'facebook':
      return [
        {
          id: 'FB_PAGE_123456789',
          name: 'Main Company Page',
          displayName: 'Example Company',
          websiteUrl: 'https://example.com',
          category: 'Business',
          followerCount: 15420
        }
      ];
    case 'instagram':
      return [
        {
          id: 'IG_ACCOUNT_123456789',
          name: 'Main Instagram',
          displayName: '@example_company',
          websiteUrl: 'https://example.com',
          accountType: 'business',
          followerCount: 25340
        }
      ];
    default:
      return [];
  }
}

// Enhanced analytics helper functions
async function getEnhancedGoogleAnalytics(token, timeRange, selectedProperties) {
  // Implementation for enhanced Google Analytics with property selection
  return {
    platform: 'google_analytics',
    timeRange,
    selectedProperties,
    metrics: {
      sessions: 12450,
      users: 8920,
      pageviews: 34560,
      bounceRate: 0.42
    },
    // Additional enhanced data would go here
  };
}

async function getEnhancedFacebookAnalytics(token, timeRange, selectedProperties) {
  // Implementation for enhanced Facebook Analytics with page selection
  return {
    platform: 'facebook',
    timeRange,
    selectedProperties,
    metrics: {
      reach: 15420,
      engagement: 1240,
      likes: 890,
      shares: 120
    }
  };
}

async function getEnhancedInstagramAnalytics(token, timeRange, selectedProperties) {
  // Implementation for enhanced Instagram Analytics with account selection
  return {
    platform: 'instagram',
    timeRange,
    selectedProperties,
    metrics: {
      impressions: 25340,
      reach: 18920,
      engagement: 2140,
      followers: 12500
    }
  };
}

async function getEnhancedYouTubeAnalytics(token, timeRange, selectedProperties) {
  // Implementation for enhanced YouTube Analytics
  return {
    platform: 'youtube',
    timeRange,
    selectedProperties,
    metrics: {
      views: 45600,
      subscribers: 3400,
      watchTime: 12800,
      engagement: 5.8
    }
  };
}

async function getEnhancedSpotifyAnalytics(token, timeRange, selectedProperties) {
  // Implementation for enhanced Spotify Analytics
  return {
    platform: 'spotify',
    timeRange,
    selectedProperties,
    metrics: {
      streams: 78900,
      listeners: 5600,
      saves: 890,
      popularity: 67
    }
  };
}

// ==================== AI ENDPOINTS ====================

// Get user AI usage
app.get('/api/ai/usage/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    
    // Validate userId
    if (!userId || userId === 'undefined' || userId === 'null') {
      return res.status(400).json({ 
        error: 'Invalid user ID',
        remaining_credits: 100,
        used_credits: 0,
        last_updated: new Date().toISOString()
      });
    }
    
    console.log(`Fetching AI usage for user: ${userId}`);
    
    const { data: usage, error } = await supabase
      .from('user_ai_usage')
      .select('remaining_credits, used_credits, last_updated')
      .eq('user_id', userId)
      .single();

    if (error && error.code !== 'PGRST116') {
      console.error('Error fetching AI usage:', error);
      // Return default values instead of error
      return res.json({
        remaining_credits: 100,
        used_credits: 0,
        last_updated: new Date().toISOString(),
        note: 'Using default values - database error'
      });
    }

    // Return default values if no record exists (PGRST116 = row not found)
    const result = usage || {
      remaining_credits: 100,
      used_credits: 0,
      last_updated: new Date().toISOString()
    };

    console.log(`AI usage for ${userId}:`, result);
    res.json(result);
  } catch (error) {
    console.error('Error fetching AI usage:', error);
    // Return default values instead of error
    res.json({
      remaining_credits: 100,
      used_credits: 0,
      last_updated: new Date().toISOString(),
      note: 'Using default values - system error'
    });
  }
});

// Generate AI insights
app.post('/api/ai/insights', async (req, res) => {
  try {
    const { analyticsData, userId } = req.body;
    
    if (!analyticsData || !userId) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    // Generate insights based on analytics data
    const insights = await generateAIInsights(analyticsData);
    
    // Update AI usage (deduct 1 credit)
    try {
      const { data: currentUsage } = await supabase
        .from('user_ai_usage')
        .select('remaining_credits, used_credits')
        .eq('user_id', userId)
        .single();

      const newUsedCredits = (currentUsage?.used_credits || 0) + 1;
      const newRemainingCredits = Math.max(0, (currentUsage?.remaining_credits || 100) - 1);

      await supabase
        .from('user_ai_usage')
        .upsert({
          user_id: userId,
          remaining_credits: newRemainingCredits,
          used_credits: newUsedCredits,
          last_updated: new Date().toISOString()
        });
    } catch (usageError) {
      console.warn('Could not update AI usage:', usageError);
      // Continue anyway - don't fail the request for usage tracking issues
    }

    res.json({ insights });
  } catch (error) {
    console.error('Error generating AI insights:', error);
    res.status(500).json({ error: 'Failed to generate insights' });
  }
});

// AI insights generation function
async function generateAIInsights(analyticsData) {
  const insights = [];
  const { platformData, overview, connectedPlatforms } = analyticsData;

  // Platform connection insights
  if (!connectedPlatforms || connectedPlatforms.length === 0) {
    insights.push({
      type: 'recommendation',
      title: 'Connect Your Platforms',
      description: 'Start by connecting your music and social media platforms to get personalized insights.',
      action: 'Connect Spotify, YouTube, or social media accounts to unlock detailed analytics.',
      icon: 'Plus',
      priority: 'high'
    });
    return insights;
  }

  // Audience growth insights
  if (overview?.totalFollowers) {
    const followers = overview.totalFollowers;
    if (followers < 1000) {
      insights.push({
        type: 'recommendation',
        title: 'Build Your Foundation',
        description: `You have ${followers.toLocaleString()} followers. Focus on consistent content creation to reach your first 1K milestone.`,
        action: 'Post regularly and engage with your audience. Aim for 3-5 posts per week across platforms.',
        icon: 'Users',
        priority: 'high'
      });
    } else if (followers < 10000) {
      insights.push({
        type: 'opportunity',
        title: 'Growing Audience',
        description: `Great progress with ${followers.toLocaleString()} followers! You're building momentum.`,
        action: 'Consider collaborations and cross-platform promotion to accelerate growth.',
        icon: 'TrendingUp',
        priority: 'medium'
      });
    } else {
      insights.push({
        type: 'positive',
        title: 'Strong Following',
        description: `Excellent! You have ${followers.toLocaleString()} followers across platforms.`,
        action: 'Focus on engagement quality and consider monetization strategies.',
        icon: 'Award',
        priority: 'low'
      });
    }
  }

  // Platform-specific insights
  if (platformData?.spotify) {
    const spotify = platformData.spotify;
    if (spotify.topTracks?.length > 0) {
      const avgPopularity = spotify.metrics?.avgPopularity || 0;
      if (avgPopularity > 60) {
        insights.push({
          type: 'positive',
          title: 'High-Performing Music',
          description: `Your tracks have an average popularity of ${avgPopularity.toFixed(0)}/100 on Spotify.`,
          action: 'Promote your top tracks on other platforms and consider similar style releases.',
          icon: 'Music',
          priority: 'medium'
        });
      }
    }
  }

  if (platformData?.youtube) {
    const youtube = platformData.youtube;
    if (youtube.channel?.videoCount < 5) {
      insights.push({
        type: 'recommendation',
        title: 'YouTube Content Opportunity',
        description: 'You have limited YouTube content. Regular uploads can boost your visibility.',
        action: 'Create a content calendar with weekly uploads. Consider tutorials or behind-the-scenes content.',
        icon: 'Video',
        priority: 'medium'
      });
    }
  }

  // Cross-platform insights
  if (connectedPlatforms.length > 1) {
    insights.push({
      type: 'positive',
      title: 'Multi-Platform Presence',
      description: `You're active on ${connectedPlatforms.length} platforms. This diversifies your reach.`,
      action: 'Maintain consistent branding and cross-promote content between platforms.',
      icon: 'Globe',
      priority: 'low'
    });
  }

  // Default insight if none generated
  if (insights.length === 0) {
    insights.push({
      type: 'recommendation',
      title: 'Keep Growing',
      description: 'Your analytics show steady progress. Consistency is key to long-term success.',
      action: 'Continue creating quality content and engaging with your audience regularly.',
      icon: 'TrendingUp',
      priority: 'medium'
    });
  }

  return insights.slice(0, 4); // Limit to 4 insights
}

// Purchase AI credits endpoint
app.post('/api/ai/purchase-credits', async (req, res) => {
  try {
    const { userId, credits, paymentToken } = req.body;
    
    if (!userId || !credits || !paymentToken) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    // Here you would integrate with a payment processor like Stripe
    // For now, we'll simulate a successful payment
    
    // Get current credits
    const { data: currentUsage } = await supabase
      .from('user_ai_usage')
      .select('remaining_credits, used_credits')
      .eq('user_id', userId)
      .single();

    const newRemainingCredits = (currentUsage?.remaining_credits || 0) + credits;

    // Update credits
    const { error: updateError } = await supabase
      .from('user_ai_usage')
      .upsert({
        user_id: userId,
        remaining_credits: newRemainingCredits,
        used_credits: currentUsage?.used_credits || 0,
        last_updated: new Date().toISOString()
      });

    if (updateError) {
      console.error('Error updating AI credits:', updateError);
      return res.status(500).json({ error: 'Failed to update credits' });
    }

    // Log purchase
    const { error: logError } = await supabase
      .from('ai_credit_purchases')
      .insert({
        user_id: userId,
        credits_purchased: credits,
        amount_paid: credits * 0.01, // $0.01 per credit
        payment_token: paymentToken,
        timestamp: new Date().toISOString()
      });

    if (logError) {
      console.error('Error logging credit purchase:', logError);
    }

    res.json({
      success: true,
      newBalance: newRemainingCredits,
      creditsPurchased: credits
    });

  } catch (error) {
    console.error('Error purchasing AI credits:', error);
    res.status(500).json({ error: 'Failed to process credit purchase' });
  }
});

// ==================== PLATFORM DATA ENDPOINTS ====================

// Get platform configurations (for frontend to know which platforms are available)
app.get('/api/platforms/configs', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('platform_oauth_configs')
      .select('platform_id, platform_name, enabled, scopes, redirect_uri')
      .eq('enabled', true);

    if (error) throw error;

    res.json(data);
  } catch (error) {
    console.error('Error fetching platform configs:', error);
    res.status(500).json({ error: 'Failed to fetch platform configurations' });
  }
});

// ==================== OAUTH CALLBACK ENDPOINTS ====================

// Generic OAuth callback handler
app.get('/api/auth/callback/:platform', async (req, res) => {
  const { platform } = req.params;
  const { code, state, error } = req.query;

  console.log(`🔄 OAuth callback for ${platform}:`, { code: code ? 'present' : 'missing', state, error });

  if (error) {
    console.error(`❌ OAuth error for ${platform}:`, error);
    return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/auth/callback/${platform}?error=${encodeURIComponent(error)}`);
  }

  if (!code || !state) {
    console.error(`❌ Missing code or state for ${platform}`);
    return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/auth/callback/${platform}?error=missing_parameters`);
  }

  try {
    // Decode state to get user info
    const stateData = JSON.parse(Buffer.from(state, 'base64').toString());
    const { userId, platform: statePlatform } = stateData;
    
    if (platform !== statePlatform) {
      throw new Error('Platform mismatch in state');
    }

    console.log(`🔍 Processing OAuth for user ${userId} on ${platform}`);
    
    // Get platform configuration
    const { data: platformConfig } = await supabase
      .from('platform_oauth_configs')
      .select('*')
      .eq('platform_id', platform)
      .eq('enabled', true)
      .single();

    if (!platformConfig) {
      throw new Error(`Platform ${platform} not configured or not enabled`);
    }

    // Exchange code for tokens based on platform
    let tokenData;
    switch (platform) {
      case 'spotify':
        tokenData = await exchangeSpotifyCode(code, platformConfig);
        break;
      case 'youtube':
      case 'google_analytics':
        tokenData = await exchangeGoogleCode(code, platformConfig);
        break;
      case 'facebook':
      case 'instagram':
        tokenData = await exchangeFacebookCode(code, platformConfig);
        break;
      case 'twitter':
        tokenData = await exchangeTwitterCode(code, platformConfig);
        break;
      case 'tiktok':
        tokenData = await exchangeTikTokCode(code, platformConfig);
        break;
      default:
        throw new Error(`OAuth not implemented for platform: ${platform}`);
    }

    console.log(`✅ Token exchange successful for ${platform}`);

    // Store tokens using direct database insertion with userId
    const expiresAt = tokenData.expires_in ? 
      new Date(Date.now() + (tokenData.expires_in * 1000)).toISOString() : null;

    const { data: insertResult, error: storeError } = await supabase
      .from('oauth_tokens')
      .upsert({
        user_id: userId,
        platform_id: platform,
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        token_type: tokenData.token_type || 'Bearer',
        expires_at: expiresAt,
        scope: tokenData.scope,
        token_data: tokenData,
        updated_at: new Date().toISOString()
      }, {
        onConflict: 'user_id,platform_id',
        returning: 'minimal'
      });

    if (storeError) {
      console.error(`❌ Error storing tokens for ${platform}:`, storeError);
      throw storeError;
    }

    console.log(`✅ Successfully stored OAuth tokens for ${platform} - User: ${userId}`);
    
    // Redirect back to frontend with success
    res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/auth/callback/${platform}?connected=${platform}&success=true`);

  } catch (error) {
    console.error(`❌ OAuth callback error for ${platform}:`, error);
    res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/auth/callback/${platform}?error=${encodeURIComponent(error.message)}`);
  }
});

// Platform-specific token exchange functions
async function exchangeSpotifyCode(code, config) {
  const response = await axios.post('https://accounts.spotify.com/api/token', 
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.redirect_uri,
      client_id: config.client_id,
      client_secret: config.client_secret
    }),
    {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    }
  );
  return response.data;
}

async function exchangeGoogleCode(code, config) {
  const response = await axios.post('https://oauth2.googleapis.com/token', {
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.redirect_uri,
    client_id: config.client_id,
    client_secret: config.client_secret
  });
  return response.data;
}

async function exchangeFacebookCode(code, config) {
  const response = await axios.get('https://graph.facebook.com/v18.0/oauth/access_token', {
    params: {
      client_id: config.client_id,
      client_secret: config.client_secret,
      redirect_uri: config.redirect_uri,
      code
    }
  });
  return response.data;
}

async function exchangeTwitterCode(code, config) {
  const response = await axios.post('https://api.twitter.com/2/oauth2/token', 
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.redirect_uri,
      client_id: config.client_id,
      code_verifier: 'challenge' // In production, this should be stored and retrieved
    }),
    {
      headers: { 
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${Buffer.from(`${config.client_id}:${config.client_secret}`).toString('base64')}`
      }
    }
  );
  return response.data;
}

async function exchangeTikTokCode(code, config) {
  const response = await axios.post('https://open-api.tiktok.com/oauth/access_token/', {
    client_key: config.client_id,
    client_secret: config.client_secret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: config.redirect_uri
  });
  return response.data;
}

// ==================== HEALTH CHECK ====================

app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// ==================== ERROR HANDLING ====================

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ==================== START SERVER ====================

app.listen(PORT, () => {
  console.log(`🚀 Analytics API Server running on port ${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
  console.log(`🔗 Supabase URL: ${process.env.REACT_APP_SUPABASE_URL}`);
});

module.exports = app;

// ==================== SOCIAL MEDIA INTEGRATION ENDPOINTS ====================
// These endpoints match what SocialMediaIntegrationService expects

// YouTube Social Data
app.post('/api/social/youtube/data', extractUserId, async (req, res) => {
  try {
    const token = await getUserOAuthToken(req.userId, 'youtube');
    if (!token) {
      return res.json({
        followers: 0,
        engagement: 0,
        posts: 0,
        recentPosts: [],
        analytics: {},
        needsReconnection: true
      });
    }

    // Get channel info and basic stats
    const channelResponse = await axios.get('https://www.googleapis.com/youtube/v3/channels', {
      headers: { Authorization: `Bearer ${token}` },
      params: {
        part: 'snippet,statistics',
        mine: true
      }
    });

    const channel = channelResponse.data.items?.[0];
    if (!channel) {
      return res.json({
        followers: 0,
        engagement: 0,
        posts: 0,
        recentPosts: [],
        analytics: {}
      });
    }

    // Get recent videos for engagement calculation
    const videosResponse = await axios.get('https://www.googleapis.com/youtube/v3/search', {
      headers: { Authorization: `Bearer ${token}` },
      params: {
        part: 'snippet',
        channelId: channel.id,
        maxResults: 10,
        order: 'date',
        type: 'video'
      }
    });

    const videoCount = parseInt(channel.statistics.videoCount) || 0;
    const subscriberCount = parseInt(channel.statistics.subscriberCount) || 0;
    const totalViews = parseInt(channel.statistics.viewCount) || 0;
    
    // Calculate engagement rate based on recent videos
    let engagementRate = 0;
    if (videosResponse.data.items?.length > 0 && subscriberCount > 0) {
      const avgViewsPerVideo = totalViews / Math.max(videoCount, 1);
      engagementRate = (avgViewsPerVideo / subscriberCount) * 100;
    }

    res.json({
      followers: subscriberCount,
      engagement: engagementRate,
      posts: videoCount,
      recentPosts: videosResponse.data.items?.slice(0, 5).map(video => ({
        id: video.id.videoId,
        title: video.snippet.title,
        description: video.snippet.description,
        thumbnail: video.snippet.thumbnails?.medium?.url,
        publishedAt: video.snippet.publishedAt,
        url: `https://www.youtube.com/watch?v=${video.id.videoId}`
      })) || [],
      analytics: {
        totalViews,
        subscriberCount,
        videoCount
      }
    });

  } catch (error) {
    console.error('YouTube social data error:', error.response?.data || error.message);
    res.json({
      followers: 0,
      engagement: 0,
      posts: 0,
      recentPosts: [],
      analytics: {},
      error: 'Failed to fetch YouTube data'
    });
  }
});

// YouTube Social Posts
app.post('/api/social/youtube/posts', extractUserId, async (req, res) => {
  try {
    const token = await getUserOAuthToken(req.userId, 'youtube');
    if (!token) {
      return res.json({
        posts: [],
        platform: 'youtube',
        needsReconnection: true
      });
    }

    const { limit = 10 } = req.body;

    // Get channel ID first
    const channelResponse = await axios.get('https://www.googleapis.com/youtube/v3/channels', {
      headers: { Authorization: `Bearer ${token}` },
      params: { part: 'id', mine: true }
    });

    const channelId = channelResponse.data.items?.[0]?.id;
    if (!channelId) {
      return res.json({
        posts: [],
        platform: 'youtube'
      });
    }

    // Get recent videos
    const videosResponse = await axios.get('https://www.googleapis.com/youtube/v3/search', {
      headers: { Authorization: `Bearer ${token}` },
      params: {
        part: 'snippet',
        channelId,
        maxResults: limit,
        order: 'date',
        type: 'video'
      }
    });

    // Get video statistics
    const videoIds = videosResponse.data.items?.map(item => item.id.videoId).join(',');
    let videosWithStats = videosResponse.data.items || [];

    if (videoIds) {
      const statsResponse = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
        headers: { Authorization: `Bearer ${token}` },
        params: {
          part: 'statistics,snippet',
          id: videoIds
        }
      });

      videosWithStats = videosResponse.data.items.map(video => {
        const stats = statsResponse.data.items?.find(stat => stat.id === video.id.videoId);
        return {
          id: video.id.videoId,
          content: video.snippet.title,
          description: video.snippet.description,
          author: video.snippet.channelTitle || 'Your Channel',
          thumbnail_url: video.snippet.thumbnails?.medium?.url,
          created_at: video.snippet.publishedAt,
          likes_count: parseInt(stats?.statistics?.likeCount) || 0,
          comments_count: parseInt(stats?.statistics?.commentCount) || 0,
          views_count: parseInt(stats?.statistics?.viewCount) || 0,
          permalink: `https://www.youtube.com/watch?v=${video.id.videoId}`,
          platform: 'youtube'
        };
      });
    }

    res.json({
      posts: videosWithStats,
      platform: 'youtube',
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('YouTube social posts error:', error.response?.data || error.message);
    res.json({
      posts: [],
      platform: 'youtube',
      error: 'Failed to fetch YouTube posts'
    });
  }
});

// Facebook Social Data
app.post('/api/social/facebook/data', extractUserId, async (req, res) => {
  try {
    const token = await getUserOAuthToken(req.userId, 'facebook');
    if (!token) {
      return res.json({
        followers: 0,
        engagement: 0,
        posts: 0,
        recentPosts: [],
        analytics: {},
        needsReconnection: true
      });
    }

    // Get page info
    const pageResponse = await axios.get('https://graph.facebook.com/v18.0/me/accounts', {
      params: {
        access_token: token,
        fields: 'id,name,fan_count,followers_count,category'
      }
    });

    const page = pageResponse.data.data?.[0] || {};
    
    // Get recent posts for engagement calculation
    const postsResponse = await axios.get('https://graph.facebook.com/v18.0/me/posts', {
      params: {
        access_token: token,
        fields: 'id,message,created_time,likes.summary(true),comments.summary(true),shares',
        limit: 10
      }
    });

    const posts = postsResponse.data.data || [];
    
    // Calculate engagement rate
    let totalEngagement = 0;
    const followers = page.followers_count || page.fan_count || 0;
    
    posts.forEach(post => {
      const likes = post.likes?.summary?.total_count || 0;
      const comments = post.comments?.summary?.total_count || 0;
      const shares = post.shares?.count || 0;
      totalEngagement += likes + comments + shares;
    });
    
    const engagementRate = posts.length > 0 && followers > 0 
      ? ((totalEngagement / posts.length) / followers) * 100 
      : 0;

    res.json({
      followers: followers,
      engagement: engagementRate,
      posts: posts.length,
      recentPosts: posts.slice(0, 5).map(post => ({
        id: post.id,
        content: post.message || '',
        created_at: post.created_time,
        likes_count: post.likes?.summary?.total_count || 0,
        comments_count: post.comments?.summary?.total_count || 0,
        shares_count: post.shares?.count || 0,
        permalink: `https://www.facebook.com/${post.id}`,
        platform: 'facebook'
      })),
      analytics: {
        totalFollowers: followers,
        fanCount: page.fan_count || 0,
        category: page.category
      }
    });

  } catch (error) {
    console.error('Facebook social data error:', error.response?.data || error.message);
    res.json({
      followers: 0,
      engagement: 0,
      posts: 0,
      recentPosts: [],
      analytics: {},
      error: 'Failed to fetch Facebook data'
    });
  }
});

// Facebook Social Posts
app.post('/api/social/facebook/posts', extractUserId, async (req, res) => {
  try {
    const token = await getUserOAuthToken(req.userId, 'facebook');
    if (!token) {
      return res.json({
        posts: [],
        platform: 'facebook',
        needsReconnection: true
      });
    }

    const { limit = 10 } = req.body;

    // Get page info first to get page name for author
    const pageResponse = await axios.get('https://graph.facebook.com/v18.0/me/accounts', {
      params: {
        access_token: token,
        fields: 'id,name'
      }
    });

    const pageName = pageResponse.data.data?.[0]?.name || 'Your Page';

    const response = await axios.get('https://graph.facebook.com/v18.0/me/posts', {
      params: {
        access_token: token,
        fields: 'id,message,created_time,likes.summary(true),comments.summary(true),shares,attachments',
        limit
      }
    });

    const posts = response.data.data?.map(post => ({
      id: post.id,
      content: post.message || '',
      author: pageName,
      media_url: post.attachments?.data?.[0]?.media?.image?.src,
      created_at: post.created_time,
      likes_count: post.likes?.summary?.total_count || 0,
      comments_count: post.comments?.summary?.total_count || 0,
      shares_count: post.shares?.count || 0,
      permalink: `https://www.facebook.com/${post.id}`,
      platform: 'facebook'
    })) || [];

    res.json({
      posts,
      platform: 'facebook',
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Facebook social posts error:', error.response?.data || error.message);
    res.json({
      posts: [],
      platform: 'facebook',
      error: 'Failed to fetch Facebook posts'
    });
  }
});

// Instagram Social Data
app.post('/api/social/instagram/data', extractUserId, async (req, res) => {
  try {
    const token = await getUserOAuthToken(req.userId, 'instagram');
    if (!token) {
      return res.json({
        followers: 0,
        engagement: 0,
        posts: 0,
        recentPosts: [],
        analytics: {},
        needsReconnection: true
      });
    }

    // Get Instagram profile data
    const profileResponse = await axios.get('https://graph.instagram.com/me', {
      params: {
        access_token: token,
        fields: 'id,username,followers_count,follows_count,media_count'
      }
    });

    const profile = profileResponse.data;
    
    // Get recent media for engagement calculation
    const mediaResponse = await axios.get('https://graph.instagram.com/me/media', {
      params: {
        access_token: token,
        fields: 'id,caption,media_type,media_url,thumbnail_url,timestamp,like_count,comments_count',
        limit: 10
      }
    });

    const media = mediaResponse.data.data || [];
    
    // Calculate engagement rate
    let totalEngagement = 0;
    media.forEach(post => {
      totalEngagement += (post.like_count || 0) + (post.comments_count || 0);
    });
    
    const engagementRate = media.length > 0 && profile.followers_count > 0 
      ? ((totalEngagement / media.length) / profile.followers_count) * 100 
      : 0;

    res.json({
      followers: profile.followers_count || 0,
      engagement: engagementRate,
      posts: profile.media_count || 0,
      recentPosts: media.slice(0, 5).map(post => ({
        id: post.id,
        content: post.caption || '',
        media_url: post.media_url || post.thumbnail_url,
        media_type: post.media_type?.toLowerCase() || 'image',
        created_at: post.timestamp,
        likes_count: post.like_count || 0,
        comments_count: post.comments_count || 0,
        platform: 'instagram'
      })),
      analytics: {
        followersCount: profile.followers_count || 0,
        followingCount: profile.follows_count || 0,
        mediaCount: profile.media_count || 0
      }
    });

  } catch (error) {
    console.error('Instagram social data error:', error.response?.data || error.message);
    res.json({
      followers: 0,
      engagement: 0,
      posts: 0,
      recentPosts: [],
      analytics: {},
      error: 'Failed to fetch Instagram data'
    });
  }
});

// Instagram Social Posts
app.post('/api/social/instagram/posts', extractUserId, async (req, res) => {
  try {
    const token = await getUserOAuthToken(req.userId, 'instagram');
    if (!token) {
      return res.json({
        posts: [],
        platform: 'instagram',
        needsReconnection: true
      });
    }

    const { limit = 10 } = req.body;

    const response = await axios.get('https://graph.instagram.com/me/media', {
      params: {
        access_token: token,
        fields: 'id,caption,media_type,media_url,thumbnail_url,timestamp,like_count,comments_count,permalink',
        limit
      }
    });

    const posts = response.data.data?.map(post => ({
      id: post.id,
      content: post.caption || '',
      media_url: post.media_url || post.thumbnail_url,
      media_type: post.media_type?.toLowerCase() || 'image',
      created_at: post.timestamp,
      likes_count: post.like_count || 0,
      comments_count: post.comments_count || 0,
      permalink: post.permalink,
      platform: 'instagram'
    })) || [];

    res.json({
      posts,
      platform: 'instagram',
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Instagram social posts error:', error.response?.data || error.message);
    res.json({
      posts: [],
      platform: 'instagram',
      error: 'Failed to fetch Instagram posts'
    });
  }
});

// Twitter Social Data
app.post('/api/social/twitter/data', extractUserId, async (req, res) => {
  try {
    const token = await getUserOAuthToken(req.userId, 'twitter');
    if (!token) {
      return res.json({
        followers: 0,
        engagement: 0,
        posts: 0,
        recentPosts: [],
        analytics: {},
        needsReconnection: true
      });
    }

    // For now, return placeholder data since Twitter API v2 setup is complex
    // This would need proper Twitter API v2 integration
    res.json({
      followers: 0,
      engagement: 0,
      posts: 0,
      recentPosts: [],
      analytics: {},
      note: 'Twitter integration requires Twitter API v2 setup'
    });

  } catch (error) {
    console.error('Twitter social data error:', error.response?.data || error.message);
    res.json({
      followers: 0,
      engagement: 0,
      posts: 0,
      recentPosts: [],
      analytics: {},
      error: 'Failed to fetch Twitter data'
    });
  }
});

// Twitter Social Posts
app.post('/api/social/twitter/posts', extractUserId, async (req, res) => {
  try {
    const token = await getUserOAuthToken(req.userId, 'twitter');
    if (!token) {
      return res.json({
        posts: [],
        platform: 'twitter',
        needsReconnection: true
      });
    }

    // Placeholder for Twitter API v2 integration
    res.json({
      posts: [],
      platform: 'twitter',
      timestamp: new Date().toISOString(),
      note: 'Twitter integration requires Twitter API v2 setup'
    });

  } catch (error) {
    console.error('Twitter social posts error:', error.response?.data || error.message);
    res.json({
      posts: [],
      platform: 'twitter',
      error: 'Failed to fetch Twitter posts'
    });
  }
});

// ==================== PLATFORM ANALYTICS ENDPOINTS ====================

// YouTube Analytics endpoint
app.post('/api/analytics/youtube', extractUserId, async (req, res) => {
  try {
    const { timeRange = '7d' } = req.body;
    console.log(`🔍 Looking up YouTube token for user: ${req.userId}`);
    
    const token = await getUserOAuthToken(req.userId, 'youtube');
    
    if (!token) {
      console.log(`❌ No YouTube token found for user ${req.userId}`);
      
      // Debug: Check what tokens this user actually has
      const { data: userTokens, error: tokenError } = await supabase
        .from('oauth_tokens')
        .select('platform_id, created_at, expires_at, is_active')
        .eq('user_id', req.userId);
        
      if (!tokenError && userTokens) {
        console.log(`🔍 User ${req.userId} has tokens for: ${userTokens.map(t => t.platform_id).join(', ')}`);
        console.log(`🔍 All user tokens:`, userTokens);
      }
      
      return res.json({
        error: 'No authentication',
        message: 'YouTube account not connected. Please connect your YouTube account to view analytics.',
        needsConnection: true,
        actionRequired: 'CONNECT',
        debugInfo: {
          userId: req.userId,
          availableTokens: userTokens ? userTokens.map(t => t.platform_id) : [],
          reason: 'NO_TOKEN_FOUND'
        }
      });
    }

    // Get channel info
    const channelResponse = await axios.get('https://www.googleapis.com/youtube/v3/channels', {
      headers: { Authorization: `Bearer ${token}` },
      params: {
        part: 'snippet,statistics,contentDetails',
        mine: true
      }
    });

    const channel = channelResponse.data.items?.[0];
    if (!channel) {
      return res.json({
        error: 'No channel found',
        message: 'No YouTube channel found for this account'
      });
    }

    // Get recent videos
    const videosResponse = await axios.get('https://www.googleapis.com/youtube/v3/search', {
      headers: { Authorization: `Bearer ${token}` },
      params: {
        part: 'snippet',
        channelId: channel.id,
        maxResults: 10,
        order: 'date',
        type: 'video'
      }
    });

    // Get video statistics
    const videoIds = videosResponse.data.items?.map(item => item.id.videoId).filter(Boolean);
    let videoStats = [];

    if (videoIds.length > 0) {
      const statsResponse = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
        headers: { Authorization: `Bearer ${token}` },
        params: {
          part: 'statistics,snippet',
          id: videoIds.join(',')
        }
      });
      videoStats = statsResponse.data.items || [];
    }

    // Calculate metrics
    const totalViews = parseInt(channel.statistics?.viewCount) || 0;
    const subscriberCount = parseInt(channel.statistics?.subscriberCount) || 0;
    const videoCount = parseInt(channel.statistics?.videoCount) || 0;
    
    const totalEngagement = videoStats.reduce((sum, video) => 
      sum + (parseInt(video.statistics?.likeCount) || 0) + 
      (parseInt(video.statistics?.commentCount) || 0), 0);

    const analytics = {
      channel: {
        id: channel.id,
        title: channel.snippet?.title,
        description: channel.snippet?.description,
        subscribers: subscriberCount,
        totalViews: totalViews,
        videoCount: videoCount,
        thumbnail: channel.snippet?.thumbnails?.default?.url,
        customUrl: channel.snippet?.customUrl,
        publishedAt: channel.snippet?.publishedAt
      },
      videos: videosResponse.data.items?.map(video => ({
        id: video.id?.videoId,
        title: video.snippet?.title,
        description: video.snippet?.description,
        publishedAt: video.snippet?.publishedAt,
        thumbnail: video.snippet?.thumbnails?.default?.url,
        channelTitle: video.snippet?.channelTitle
      })) || [],
      videoStats: videoStats.map(video => ({
        id: video.id,
        title: video.snippet?.title,
        views: parseInt(video.statistics?.viewCount) || 0,
        likes: parseInt(video.statistics?.likeCount) || 0,
        comments: parseInt(video.statistics?.commentCount) || 0,
        publishedAt: video.snippet?.publishedAt
      })),
      metrics: {
        avgViewsPerVideo: videoCount > 0 ? Math.round(totalViews / videoCount) : 0,
        subscriberGrowth: 0, // Would need historical data
        totalEngagement: totalEngagement,
        engagementRate: subscriberCount > 0 ? (totalEngagement / subscriberCount) * 100 : 0
      },
      timeRange: timeRange,
      timestamp: new Date().toISOString()
    };

    console.log(`✅ YouTube analytics data compiled for user ${req.userId}`);
    res.json(analytics);

  } catch (error) {
    console.error('YouTube analytics error:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Failed to fetch YouTube analytics',
      message: error.response?.data?.error?.message || error.message
    });
  }
});

// ==================== EXISTING ENDPOINTS ==================== 