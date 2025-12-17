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
      imgSrc: ["'self'", "data:", "https://*.huggingface.co", "blob:", "*"],
    },
  },
}));

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Rate limiting - only for protection, not billing
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60, // 60 requests per minute max (safety limit)
  message: { 
    success: false,
    error: 'rate_limit_exceeded',
    message: 'Too many requests. Please slow down.' 
  },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

// Hugging Face configuration
const HF_ROUTER_URL = 'https://router.huggingface.co/hf-inference';
const HF_TOKEN = process.env.HUGGINGFACE_TOKEN;

if (!HF_TOKEN) {
  console.error('ERROR: HUGGINGFACE_TOKEN is not set in environment variables');
  process.exit(1);
}

// Plan resolution limits ONLY (RapidAPI handles request counts)
const PLAN_RESOLUTIONS = {
  'basic': 512,    // Free plan: 512px max
  'pro': 768,      // Pro plan: 768px max
  'ultra': 1024,   // Ultra plan: 1024px max
  'mega': 1024     // Mega plan: 1024px max
};

// Simple plan detection from RapidAPI headers
const detectUserPlan = (req, res, next) => {
  // RapidAPI sends plan in headers
  const rapidApiPlan = req.headers['x-rapidapi-plan'];
  const rapidApiSubscription = req.headers['x-rapidapi-subscription'];
  
  if (rapidApiPlan && PLAN_RESOLUTIONS[rapidApiPlan.toLowerCase()]) {
    // Paid user via RapidAPI
    req.userPlan = rapidApiPlan.toLowerCase();
    req.isPaidUser = true;
  } else if (rapidApiSubscription) {
    // Has subscription but no plan header? Default to pro
    req.userPlan = 'pro';
    req.isPaidUser = true;
  } else {
    // Free user or direct access
    req.userPlan = 'basic';
    req.isPaidUser = false;
  }
  
  req.clientId = req.headers['x-rapidapi-user'] || 
                 req.headers['x-api-key'] || 
                 req.ip || 
                 'anonymous';
  
  next();
};

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'AI Text-to-Image API',
    version: '2.3.0',
    model: 'stabilityai/stable-diffusion-xl-base-1.0',
    endpoint: 'router.huggingface.co',
    uptime: process.uptime(),
    pricing_plans: {
      basic: { price: 0, max_resolution: '512x512' },
      pro: { price: 14.99, max_resolution: '768x768' },
      ultra: { price: 49.99, max_resolution: '1024x1024' },
      mega: { price: 149.99, max_resolution: '1024x1024' }
    },
    endpoints: {
      generate: 'POST /api/generate',
      models: 'GET /api/models',
      status: 'GET /api/status'
    },
    note: 'Request limits enforced by RapidAPI. This API only enforces resolution limits.'
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
      recommended: true
    }
  ];
  res.json({ success: true, models });
});

// API status check
app.get('/api/status', async (req, res) => {
  try {
    // Quick check if Hugging Face is reachable
    await axios.get(
      `${HF_ROUTER_URL}/models/stabilityai/stable-diffusion-xl-base-1.0`,
      {
        headers: { 
          'Authorization': `Bearer ${HF_TOKEN}`,
          'Content-Type': 'application/json'
        },
        timeout: 5000
      }
    );
    
    res.json({
      success: true,
      status: 'operational',
      model: 'stabilityai/stable-diffusion-xl-base-1.0',
      endpoint: 'router.huggingface.co',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    // Don't fail hard, just report partial status
    res.json({
      success: true,
      status: 'degraded',
      api: 'online',
      huggingface: 'connection_issue',
      message: 'API is running but Hugging Face connection may be unstable',
      timestamp: new Date().toISOString()
    });
  }
});

// Main generation endpoint
app.post('/api/generate', detectUserPlan, async (req, res) => {
  const startTime = Date.now();
  
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

    // Get user's plan and max allowed resolution
    const userPlan = req.userPlan;
    const maxAllowed = PLAN_RESOLUTIONS[userPlan] || 512;
    const requestedWidth = parseInt(width);
    const requestedHeight = parseInt(height);
    
    // Enforce resolution limits based on plan
    if (requestedWidth > maxAllowed || requestedHeight > maxAllowed) {
      return res.status(400).json({
        success: false,
        error: 'plan_limit_exceeded',
        message: `${userPlan} plan maximum resolution is ${maxAllowed}x${maxAllowed}. Upgrade to a higher plan for ${requestedWidth}x${requestedHeight}.`,
        current_plan: userPlan,
        max_allowed: maxAllowed,
        requested: `${requestedWidth}x${requestedHeight}`,
        upgrade_url: 'https://rapidapi.com/your-username/your-api/pricing'
      });
    }

    // Basic dimension validation
    if (requestedWidth < 64 || requestedHeight < 64 || requestedWidth > 1024 || requestedHeight > 1024) {
      return res.status(400).json({
        success: false,
        error: 'invalid_dimensions',
        message: 'Width and height must be between 64 and 1024 pixels'
      });
    }

    // Log the request
    console.log(`[${new Date().toISOString()}] [${userPlan.toUpperCase()}] ${req.clientId}: "${prompt.substring(0, 50)}${prompt.length > 50 ? '...' : ''}"`);

    // Prepare request for Hugging Face Router
    const payload = {
      inputs: prompt,
      parameters: {
        negative_prompt: negative_prompt,
        width: requestedWidth,
        height: requestedHeight,
        num_inference_steps: parseInt(num_inference_steps),
        guidance_scale: parseFloat(guidance_scale)
      }
    };

    // Call Hugging Face Router API
    const routerUrl = `${HF_ROUTER_URL}/models/${model}`;
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
    
    // Convert image buffer to base64
    const imageBase64 = Buffer.from(response.data).toString('base64');
    const imageUrl = `data:image/png;base64,${imageBase64}`;

    // Success response
    res.json({
      success: true,
      data: {
        id: `img_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        prompt: prompt,
        image: imageUrl,
        model: model,
        dimensions: { width: requestedWidth, height: requestedHeight },
        generation_time_ms: generationTime,
        timestamp: new Date().toISOString(),
        plan: userPlan,
        max_resolution_allowed: `${maxAllowed}x${maxAllowed}`,
        note: req.isPaidUser ? 
          `Thank you for your ${userPlan} subscription!` :
          'Using free tier. Upgrade for higher resolutions and more features.'
      }
    });

  } catch (error) {
    console.error('Generation failed:', error.message);
    
    const errorResponse = {
      success: false,
      error: 'generation_failed',
      plan: req.userPlan
    };

    if (error.response) {
      // Router API error
      try {
        const errorData = Buffer.from(error.response.data).toString();
        const parsedError = JSON.parse(errorData);
        errorResponse.message = parsedError.error || parsedError.message || 'Hugging Face API error';
        errorResponse.details = parsedError;
      } catch (e) {
        errorResponse.message = 'Hugging Face API error';
      }
      
      if (error.response.status === 401) {
        errorResponse.error = 'invalid_api_token';
        errorResponse.message = 'Invalid Hugging Face API token';
        res.status(401);
      } else if (error.response.status === 402) {
        errorResponse.error = 'payment_required';
        errorResponse.message = 'Hugging Face endpoint requires payment. Please contact support.';
        res.status(402);
      } else if (error.response.status === 429) {
        errorResponse.error = 'rate_limited';
        errorResponse.message = 'Rate limit reached. Please try again later.';
        res.status(429);
      } else {
        res.status(502);
      }
    } else if (error.request) {
      // Network error
      errorResponse.error = 'network_error';
      errorResponse.message = 'Cannot connect to Hugging Face service';
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

// Simple batch endpoint (placeholder - users can implement their own batching)
app.post('/api/generate/batch', detectUserPlan, (req, res) => {
  res.json({
    success: false,
    error: 'not_implemented',
    message: 'Batch processing not available in current plan. Contact support for enterprise solutions.',
    upgrade_suggestion: 'Mega plan includes batch processing features'
  });
});

// Admin endpoint (optional - keep it simple)
app.get('/admin/health', (req, res) => {
  const adminKey = process.env.ADMIN_KEY;
  
  if (adminKey && req.headers['admin-key'] !== adminKey) {
    return res.status(403).json({ 
      success: false,
      error: 'unauthorized' 
    });
  }
  
  res.json({
    success: true,
    status: 'healthy',
    timestamp: new Date().toISOString(),
    memory: process.memoryUsage(),
    uptime: process.uptime(),
    plan: 'RapidAPI integrated - no local tracking'
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

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.stack);
  res.status(500).json({
    success: false,
    error: 'internal_error',
    message: 'An unexpected error occurred',
    timestamp: new Date().toISOString()
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 AI Text-to-Image API (v2.3.0) running on port ${PORT}`);
  console.log(`🔗 Health: http://localhost:${PORT}/`);
  console.log(`🤖 Model: Stable Diffusion XL via Hugging Face Router`);
  console.log(`💰 Pricing: RapidAPI managed (Basic/Pro/Ultra/Mega)`);
  console.log(`📊 Request limits: Handled by RapidAPI`);
  console.log(`⚙️  Resolution limits: Enforced by API`);
});