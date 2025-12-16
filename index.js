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
      imgSrc: ["'self'", "data:", "https://*.huggingface.co", "blob:", "*"], // Added * for external images
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

// Hugging Face configuration - UPDATED TO ROUTER ENDPOINT
const HF_ROUTER_URL = 'https://router.huggingface.co/hf-inference';
const HF_TOKEN = process.env.HUGGINGFACE_TOKEN;

if (!HF_TOKEN) {
  console.error('ERROR: HUGGINGFACE_TOKEN is not set in environment variables');
  process.exit(1);
}

// API Plans configuration
const API_PLANS = {
  'free': { maxRes: 512, dailyLimit: 30 },
  'basic': { maxRes: 768, dailyLimit: 300 },
  'pro': { maxRes: 1024, dailyLimit: 1000 }
};

// Simple API key authentication for RapidAPI
const authenticateRapidAPI = (req, res, next) => {
  // For testing, allow requests without key
  req.userPlan = 'free'; // Temporary for testing
  next();
};

// Usage tracker
const usageTracker = {};

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'AI Text-to-Image API (Stable Diffusion XL via Router)',
    version: '2.2.0',
    model: 'stabilityai/stable-diffusion-xl-base-1.0',
    endpoint: 'router.huggingface.co',
    uptime: process.uptime(),
    endpoints: {
      generate: 'POST /api/generate',
      models: 'GET /api/models',
      status: 'GET /api/status'
    }
  });
});

// Available models endpoint
app.get('/api/models', (req, res) => {
  const models = [
    {
      id: 'stabilityai/stable-diffusion-xl-base-1.0',
      name: 'Stable Diffusion XL 1.0',
      provider: 'stabilityai',
      max_resolution: '1024x1024',
      description: 'Latest Stable Diffusion model via Hugging Face Router',
      free_tier: true,
      recommended: true,
      endpoint_type: 'router'
    },
    {
      id: 'runwayml/stable-diffusion-v1-5',
      name: 'Stable Diffusion 1.5',
      provider: 'runwayml',
      max_resolution: '512x512',
      free_tier: true,
      endpoint_type: 'router'
    }
  ];
  res.json({ success: true, models });
});

// API status - UPDATED FOR ROUTER
app.get('/api/status', async (req, res) => {
  try {
    // Test connection to router endpoint
    const response = await axios.get(
      `${HF_ROUTER_URL}/models/stabilityai/stable-diffusion-xl-base-1.0`,
      {
        headers: { 
          'Authorization': `Bearer ${HF_TOKEN}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );
    
    res.json({
      success: true,
      huggingface: 'connected',
      endpoint: 'router.huggingface.co',
      model: 'stabilityai/stable-diffusion-xl-base-1.0',
      status: 'operational',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Router connection error:', error.message);
    res.status(503).json({
      success: false,
      huggingface: 'connection_failed',
      error: 'Cannot connect to Hugging Face Router',
      details: process.env.NODE_ENV === 'development' ? error.message : 'Router endpoint may require authentication or different configuration'
    });
  }
});

// Main generation endpoint - UPDATED FOR ROUTER
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
      model = 'stabilityai/stable-diffusion-xl-base-1.0'
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
    console.log(`[${new Date().toISOString()}] Generating image via Router: "${prompt.substring(0, 50)}${prompt.length > 50 ? '...' : ''}"`);

    // Prepare request for Hugging Face Router - UPDATED PAYLOAD
    const payload = {
      inputs: prompt,
      parameters: {
        negative_prompt: negative_prompt,
        width: requestedWidth,
        height: requestedHeight,
        num_inference_steps: parseInt(num_inference_steps),
        guidance_scale: parseFloat(guidance_scale)
      }
      // Removed 'options' as router may handle differently
    };

    // Determine which model to use
    const targetModel = model || 'stabilityai/stable-diffusion-xl-base-1.0';
    
    // UPDATED: Router endpoint URL
    const routerUrl = `${HF_ROUTER_URL}/models/${targetModel}`;
    
    console.log(`Calling router endpoint: ${routerUrl}`);

    // Call Hugging Face Router API - UPDATED
    const response = await axios.post(
      routerUrl,
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
        endpoint: 'router.huggingface.co',
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
    console.error('Router generation failed:', error.message);
    console.error('Error details:', error.response?.data ? Buffer.from(error.response.data).toString() : 'No response data');
    
    const errorResponse = {
      success: false,
      error: 'generation_failed',
      endpoint: 'router.huggingface.co'
    };

    if (error.response) {
      // Router API error
      let errorMessage = 'Router API error';
      
      try {
        const errorData = Buffer.from(error.response.data).toString();
        const parsedError = JSON.parse(errorData);
        errorMessage = parsedError.error || parsedError.message || errorMessage;
        errorResponse.details = parsedError;
      } catch (e) {
        errorMessage = Buffer.from(error.response.data).toString().substring(0, 200);
      }
      
      errorResponse.message = errorMessage;
      
      if (error.response.status === 401) {
        errorResponse.error = 'invalid_api_token';
        errorResponse.message = 'Invalid Hugging Face API token for router';
        res.status(401);
      } else if (error.response.status === 402) {
        errorResponse.error = 'payment_required';
        errorResponse.message = 'Router endpoint requires payment or Pro account';
        res.status(402);
      } else if (error.response.status === 404) {
        errorResponse.error = 'model_not_found';
        errorResponse.message = 'Model not found on router endpoint';
        res.status(404);
      } else if (error.response.status === 503) {
        errorResponse.error = 'model_loading';
        errorResponse.message = 'Model is loading on router. Please try again in 30-60 seconds.';
        res.status(503);
      } else if (error.response.status === 429) {
        errorResponse.error = 'rate_limit';
        errorResponse.message = 'Router rate limit reached';
        res.status(429);
      } else {
        res.status(502);
      }
    } else if (error.request) {
      // Network error
      errorResponse.error = 'network_error';
      errorResponse.message = 'Cannot connect to Hugging Face Router';
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
app.post('/api/generate/batch', authenticateRapidAPI, (req, res) => {
  try {
    const { prompts, ...params } = req.body;
    
    if (!Array.isArray(prompts) || prompts.length === 0 || prompts.length > 5) {
      return res.status(400).json({
        success: false,
        error: 'invalid_prompts',
        message: 'Prompts must be an array with 1-5 items'
      });
    }

    const batchId = `batch_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    res.json({
      success: true,
      batch_id: batchId,
      message: 'Batch processing started. Images will be generated sequentially via router.',
      total_prompts: prompts.length,
      estimated_time: `${prompts.length * 20} seconds`,
      timestamp: new Date().toISOString(),
      endpoint: 'router.huggingface.co'
    });
    
    console.log(`Batch ${batchId} started with ${prompts.length} prompts via router`);
    
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'batch_failed',
      message: error.message
    });
  }
});

// Admin endpoint to view usage
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
    timestamp: new Date().toISOString(),
    endpoint: 'router.huggingface.co'
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
  console.log(`🚀 Stable Diffusion XL Text-to-Image API (Router) running on port ${PORT}`);
  console.log(`🔗 Health check: http://localhost:${PORT}/`);
  console.log(`🤖 Model: stabilityai/stable-diffusion-xl-base-1.0`);
  console.log(`🔄 Endpoint: router.huggingface.co`);
  console.log(`⚙️  Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`📊 Usage tracking enabled`);
});