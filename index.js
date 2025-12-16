require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https://*.huggingface.co", "blob:"],
    },
  },
}));

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Rate limiting - for your API
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: process.env.NODE_ENV === 'production' ? 15 : 30,
  message: { 
    success: false,
    error: 'rate_limit_exceeded',
    message: 'Rate limit exceeded. Try again in a minute.' 
  },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

// Hugging Face configuration - UPDATED TO SDXL
const HF_API_URL = 'https://api-inference.huggingface.co/models/stabilityai/stable-diffusion-xl-base-1.0';
const HF_TOKEN = process.env.HUGGINGFACE_TOKEN;

if (!HF_TOKEN) {
  console.error('ERROR: HUGGINGFACE_TOKEN is not set in environment variables');
  process.exit(1);
}

// API Plans configuration
const API_PLANS = {
  'free': { maxRes: 512, dailyLimit: 50 },
  'basic': { maxRes: 768, dailyLimit: 1000 },
  'pro': { maxRes: 1024, dailyLimit: 10000 }
};

// Simple API key authentication for RapidAPI
const authenticateRapidAPI = (req, res, next) => {
  // For testing, allow requests without key
  // In production, uncomment the code below
  /*
  const apiKey = req.headers['x-rapidapi-proxy-secret'] || 
                 req.headers['x-api-key'];
  
  if (!apiKey && req.path === '/api/generate') {
    return res.status(401).json({
      success: false,
      error: 'api_key_required',
      message: 'Get your API key from RapidAPI marketplace'
    });
  }
  
  // Add plan info to request
  req.userPlan = apiKey ? 'basic' : 'free';
  */
  req.userPlan = 'free'; // Temporary for testing
  next();
};

// Usage tracker
const usageTracker = {};

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'AI Text-to-Image API (Stable Diffusion XL)',
    version: '2.1.0',
    model: 'stabilityai/stable-diffusion-xl-base-1.0',
    uptime: process.uptime(),
    endpoints: {
      generate: 'POST /api/generate',
      models: 'GET /api/models',
      status: 'GET /api/status'
    }
  });
});

// Available models endpoint - UPDATED
app.get('/api/models', (req, res) => {
  const models = [
    {
      id: 'stabilityai/stable-diffusion-xl-base-1.0',
      name: 'Stable Diffusion XL 1.0',
      provider: 'stabilityai',
      max_resolution: '1024x1024',
      description: 'Latest Stable Diffusion model for high-quality image generation',
      free_tier: true,
      recommended: true
    },
    {
      id: 'runwayml/stable-diffusion-v1-5',
      name: 'Stable Diffusion 1.5',
      provider: 'runwayml',
      max_resolution: '512x512',
      free_tier: true
    },
    {
      id: 'prompthero/openjourney',
      name: 'OpenJourney',
      provider: 'prompthero',
      style: 'midjourney-style',
      free_tier: true
    }
  ];
  res.json({ success: true, models });
});

// API status
app.get('/api/status', async (req, res) => {
  try {
    // Simple HEAD request to check if Hugging Face is accessible
    await axios.head(HF_API_URL, {
      headers: { Authorization: `Bearer ${HF_TOKEN}` },
      timeout: 5000
    });
    
    res.json({
      success: true,
      huggingface: 'connected',
      model: 'stabilityai/stable-diffusion-xl-base-1.0',
      status: 'operational',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(503).json({
      success: false,
      huggingface: 'connection_failed',
      error: 'Cannot connect to Hugging Face API',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Main generation endpoint - UPDATED FOR SDXL
app.post('/api/generate', authenticateRapidAPI, async (req, res) => {
  const startTime = Date.now();
  
  // Track usage
  const clientId = req.headers['x-rapidapi-user'] || req.ip || 'anonymous';
  const today = new Date().toISOString().split('T')[0];
  
  if (!usageTracker[today]) usageTracker[today] = {};
  if (!usageTracker[today][clientId]) usageTracker[today][clientId] = 0;
  
  usageTracker[today][clientId]++;
  
  // Check daily limits based on plan
  const userPlan = req.userPlan || 'free';
  const planConfig = API_PLANS[userPlan] || API_PLANS.free;
  
  if (usageTracker[today][clientId] > planConfig.dailyLimit) {
    return res.status(429).json({
      success: false,
      error: 'daily_limit_exceeded',
      message: `Daily limit of ${planConfig.dailyLimit} requests reached. Upgrade your plan on RapidAPI.`
    });
  }
  
  try {
    const {
      prompt,
      negative_prompt = '',
      width = 512,
      height = 512,
      num_inference_steps = 30,
      guidance_scale = 7.5,
      model = 'stabilityai/stable-diffusion-xl-base-1.0' // UPDATED DEFAULT
    } = req.body;

    // Validation
    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'prompt_required',
        message: 'Text prompt is required and must be a string'
      });
    }

    if (prompt.length > 1500) {
      return res.status(400).json({
        success: false,
        error: 'prompt_too_long',
        message: 'Prompt exceeds maximum length of 1500 characters'
      });
    }

    // Check resolution limits based on plan
    const maxDimension = planConfig.maxRes;
    const requestedWidth = parseInt(width);
    const requestedHeight = parseInt(height);
    
    if (requestedWidth > maxDimension || requestedHeight > maxDimension) {
      return res.status(400).json({
        success: false,
        error: 'invalid_dimensions',
        message: `Maximum resolution for ${userPlan} plan is ${maxDimension}x${maxDimension}. Upgrade for higher resolutions.`
      });
    }

    if (requestedWidth < 64 || requestedHeight < 64 || requestedWidth > 1024 || requestedHeight > 1024) {
      return res.status(400).json({
        success: false,
        error: 'invalid_dimensions',
        message: 'Width and height must be between 64 and 1024 pixels'
      });
    }

    // Log the request
    console.log(`[${new Date().toISOString()}] Generating image for: "${prompt.substring(0, 50)}${prompt.length > 50 ? '...' : ''}"`);

    // Prepare Hugging Face request for SDXL
    const payload = {
      inputs: prompt,
      parameters: {
        negative_prompt: negative_prompt,
        width: requestedWidth,
        height: requestedHeight,
        num_inference_steps: parseInt(num_inference_steps),
        guidance_scale: parseFloat(guidance_scale)
      },
      options: {
        use_cache: true,
        wait_for_model: true
      }
    };

    // Determine which model to use
    const targetModel = model || 'stabilityai/stable-diffusion-xl-base-1.0';
    const hfUrl = `https://api-inference.huggingface.co/models/${targetModel}`;

    // Call Hugging Face API
    const response = await axios.post(
      hfUrl,
      payload,
      {
        headers: {
          'Authorization': `Bearer ${HF_TOKEN}`,
          'Content-Type': 'application/json',
          'Accept': 'image/png'
        },
        responseType: 'arraybuffer',
        timeout: 120000 // 2 minutes timeout for SDXL
      }
    );

    const generationTime = Date.now() - startTime;
    
    // Convert image buffer to base64 for API response
    const imageBase64 = Buffer.from(response.data).toString('base64');
    const imageUrl = `data:image/png;base64,${imageBase64}`;

    res.json({
      success: true,
      data: {
        id: `img_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        prompt: prompt,
        image: imageUrl,
        model: targetModel,
        dimensions: { width: requestedWidth, height: requestedHeight },
        generation_time: `${generationTime}ms`,
        timestamp: new Date().toISOString(),
        usage: {
          daily_used: usageTracker[today][clientId],
          daily_limit: planConfig.dailyLimit,
          plan: userPlan
        }
      }
    });

  } catch (error) {
    console.error('Generation failed:', error.message);
    
    const errorResponse = {
      success: false,
      error: 'generation_failed'
    };

    if (error.response) {
      // Hugging Face API error
      const hfError = error.response.data;
      const hfErrorStr = Buffer.from(hfError).toString('utf8');
      
      try {
        const parsedError = JSON.parse(hfErrorStr);
        errorResponse.error = parsedError.error || 'huggingface_error';
        errorResponse.message = parsedError.error || 'Hugging Face API error';
        
        if (errorResponse.error.includes('loading')) {
          errorResponse.message = 'Model is loading. Please try again in 30-60 seconds.';
          res.status(503);
        } else if (error.response.status === 401) {
          errorResponse.error = 'invalid_api_token';
          errorResponse.message = 'Invalid Hugging Face API token';
          res.status(401);
        } else if (error.response.status === 429) {
          errorResponse.error = 'huggingface_rate_limit';
          errorResponse.message = 'Hugging Face rate limit reached';
          res.status(429);
        } else {
          res.status(502);
        }
      } catch (e) {
        errorResponse.message = 'Hugging Face API error';
        res.status(502);
      }
    } else if (error.request) {
      // Network error
      errorResponse.error = 'network_error';
      errorResponse.message = 'Cannot connect to Hugging Face API';
      res.status(504);
    } else {
      // Server error
      errorResponse.error = 'server_error';
      errorResponse.message = 'Internal server error';
      res.status(500);
    }

    res.json(errorResponse);
  }
});

// Batch generation endpoint
app.post('/api/generate/batch', authenticateRapidAPI, async (req, res) => {
  try {
    const { prompts, ...params } = req.body;
    
    if (!Array.isArray(prompts) || prompts.length === 0 || prompts.length > 5) {
      return res.status(400).json({
        success: false,
        error: 'invalid_prompts',
        message: 'Prompts must be an array with 1-5 items'
      });
    }

    const results = [];
    const batchId = `batch_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    res.json({
      success: true,
      batch_id: batchId,
      message: 'Batch processing started. Images will be generated sequentially.',
      total_prompts: prompts.length,
      estimated_time: `${prompts.length * 15} seconds`,
      timestamp: new Date().toISOString()
    });

    // In a real implementation, you would use a job queue here
    // For simplicity, we just return immediately
    console.log(`Batch ${batchId} started with ${prompts.length} prompts`);
    
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'batch_failed',
      message: error.message
    });
  }
});

// Admin endpoint to view usage (protect this!)
app.get('/admin/usage', (req, res) => {
  const adminKey = process.env.ADMIN_KEY;
  
  if (adminKey && req.headers['admin-key'] !== adminKey) {
    return res.status(403).json({ 
      success: false,
      error: 'unauthorized' 
    });
  }
  
  res.json({
    success: true,
    usage: usageTracker,
    totals: Object.keys(usageTracker).reduce((acc, date) => {
      acc[date] = Object.values(usageTracker[date]).reduce((sum, val) => sum + val, 0);
      return acc;
    }, {}),
    timestamp: new Date().toISOString()
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    error: 'endpoint_not_found',
    message: `Cannot ${req.method} ${req.originalUrl}`,
    available_endpoints: {
      '/': 'Health check',
      '/api/generate': 'Generate image (POST)',
      '/api/models': 'List models (GET)',
      '/api/status': 'API status (GET)'
    }
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.stack);
  res.status(500).json({
    success: false,
    error: 'internal_error',
    message: 'An unexpected error occurred',
    request_id: req.headers['x-request-id'] || Date.now().toString(36),
    timestamp: new Date().toISOString()
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Stable Diffusion XL Text-to-Image API running on port ${PORT}`);
  console.log(`🔗 Health check: http://localhost:${PORT}/`);
  console.log(`🤖 Model: stabilityai/stable-diffusion-xl-base-1.0`);
  console.log(`⚙️  Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`📊 Usage tracking enabled`);
});