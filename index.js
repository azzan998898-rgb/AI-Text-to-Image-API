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

// ✅ YOUR NEW PRICING - Resolution limits ONLY
// RapidAPI handles request counts automatically
const PLAN_CONFIG = {
  'basic': { 
    maxResolution: 512,
    name: 'Basic',
    price: 0,
    // Note: RapidAPI handles the 50 requests/month limit
  },
  'pro': { 
    maxResolution: 768,
    name: 'Pro',
    price: 19,
    // Note: RapidAPI handles the 2,000 requests/month limit
  },
  'ultra': { 
    maxResolution: 1024,
    name: 'Ultra',
    price: 59,
    // Note: RapidAPI handles the 10,000 requests/month limit
  },
  'mega': { 
    maxResolution: 1024,
    name: 'Mega',
    price: 199,
    // Note: RapidAPI handles the 40,000 requests/month limit
  }
};

// Simple plan detection from RapidAPI headers
const detectUserPlan = (req, res, next) => {
  // RapidAPI sends plan in headers
  const rapidApiPlan = req.headers['x-rapidapi-plan'];
  
  // Default to 'basic' if no plan header (free users or direct access)
  const planKey = rapidApiPlan ? rapidApiPlan.toLowerCase() : 'basic';
  
  // Validate plan exists, fallback to basic
  req.userPlan = PLAN_CONFIG[planKey] ? planKey : 'basic';
  req.userPlanConfig = PLAN_CONFIG[req.userPlan];
  
  // Track client for logging
  req.clientId = req.headers['x-rapidapi-user'] || 
                 req.headers['x-api-key'] || 
                 req.ip || 
                 'anonymous';
  
  next();
};

// Health check with pricing info
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'AI Text-to-Image API',
    version: '2.4.0',
    model: 'stabilityai/stable-diffusion-xl-base-1.0',
    endpoint: 'router.huggingface.co',
    uptime: process.uptime(),
    
    // ✅ YOUR PRICING - CLEARLY DISPLAYED
    pricing_plans: {
      basic: { 
        price: 0, 
        max_resolution: '512x512',
        note: 'Perfect for testing and prototyping'
      },
      pro: { 
        price: 19, 
        max_resolution: '768x768',
        note: 'Best for small apps and regular use'
      },
      ultra: { 
        price: 59, 
        max_resolution: '1024x1024',
        note: 'Great for growing applications'
      },
      mega: { 
        price: 199, 
        max_resolution: '1024x1024',
        note: 'For high-volume and enterprise use'
      }
    },
    
    important_notes: [
      'All prices are monthly subscriptions',
      'Request limits are enforced by RapidAPI',
      'This API only enforces resolution limits',
      'Images generated with Stable Diffusion XL'
    ],
    
    endpoints: {
      generate: 'POST /api/generate',
      models: 'GET /api/models',
      status: 'GET /api/status'
    },
    
    // Quick cost comparison (your competitive advantage)
    cost_per_1000_images: {
      pro: '$9.50',
      ultra: '$5.90', 
      mega: '$4.98',
      comparison: 'Typically $12-20 elsewhere'
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

    // ✅ Get user's plan and max allowed resolution
    const userPlan = req.userPlan;
    const userPlanConfig = req.userPlanConfig;
    const maxAllowed = userPlanConfig.maxResolution;
    
    const requestedWidth = parseInt(width);
    const requestedHeight = parseInt(height);
    
    // ✅ Enforce resolution limits based on plan
    if (requestedWidth > maxAllowed || requestedHeight > maxAllowed) {
      return res.status(400).json({
        success: false,
        error: 'plan_limit_exceeded',
        message: `${userPlanConfig.name} plan maximum resolution is ${maxAllowed}x${maxAllowed}.`,
        current_plan: userPlanConfig.name,
        max_allowed: maxAllowed,
        requested: `${requestedWidth}x${requestedHeight}`,
        upgrade_suggestion: userPlan === 'basic' ? 'Upgrade to Pro ($19) for 768x768' :
                          userPlan === 'pro' ? 'Upgrade to Ultra ($59) for 1024x1024' :
                          'Contact for custom enterprise plans'
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

    // Log the request with plan info
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

    // ✅ Success response with plan info
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
        
        // ✅ Plan information for user clarity
        plan: {
          name: userPlanConfig.name,
          price: userPlanConfig.price,
          max_resolution: `${maxAllowed}x${maxAllowed}`,
          value_message: userPlan === 'basic' ? 
            'Using free tier. Upgrade for higher resolution images.' :
            `Thank you for your ${userPlanConfig.name} subscription!`
        },
        
        // Quick links for upgrade
        upgrade_info: userPlan !== 'mega' ? {
          next_plan: userPlan === 'basic' ? 'Pro' : userPlan === 'pro' ? 'Ultra' : 'Mega',
          benefit: userPlan === 'basic' ? '768x768 resolution' : 
                  userPlan === 'pro' ? '1024x1024 resolution' : 
                  'Higher request limits'
        } : null
      }
    });

  } catch (error) {
    console.error('Generation failed:', error.message);
    
    const errorResponse = {
      success: false,
      error: 'generation_failed',
      plan: req.userPlanConfig.name
    };

    if (error.response) {
      // Router API error
      try {
        const errorData = Buffer.from(error.response.data).toString();
        const parsedError = JSON.parse(errorData);
        errorResponse.message = parsedError.error || parsedError.message || 'Hugging Face API error';
      } catch (e) {
        errorResponse.message = 'Hugging Face API error';
      }
      
      if (error.response.status === 401) {
        errorResponse.error = 'invalid_api_token';
        errorResponse.message = 'Invalid Hugging Face API token';
        res.status(401);
      } else if (error.response.status === 402) {
        errorResponse.error = 'payment_required';
        errorResponse.message = 'Hugging Face endpoint requires payment.';
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

// Admin endpoint (secured)
app.get('/admin/health', (req, res) => {
  const adminKey = process.env.ADMIN_KEY;
  const providedKey = req.headers['admin-key'];
  
  if (!adminKey || !providedKey || providedKey !== adminKey) {
    return res.status(403).json({ 
      success: false,
      error: 'unauthorized' 
    });
  }
  
  res.json({
    success: true,
    status: 'healthy',
    service: 'AI Text-to-Image API',
    version: '2.4.0',
    timestamp: new Date().toISOString(),
    pricing_model: 'Revenue-funded (no losses)',
    current_plan_limits: PLAN_CONFIG
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    error: 'endpoint_not_found',
    message: `Cannot ${req.method} ${req.originalUrl}`,
    available_endpoints: {
      '/': 'Health check with pricing',
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
  console.log(`🚀 AI Text-to-Image API (v2.4.0) running on port ${PORT}`);
  console.log(`🔗 Health: http://localhost:${PORT}/`);
  console.log(`🤖 Model: Stable Diffusion XL via Hugging Face Router`);
  console.log(`💰 PRICING LIVE:`);
  console.log(`   Basic: $0 for 50 requests/month (512px)`);
  console.log(`   Pro: $19 for 2,000 requests/month (768px)`);
  console.log(`   Ultra: $59 for 10,000 requests/month (1024px)`);
  console.log(`   Mega: $199 for 40,000 requests/month (1024px)`);
  console.log(`📊 Request limits: Handled by RapidAPI`);
  console.log(`⚙️  Resolution limits: Enforced by API`);
  console.log(`💡 Strategy: Revenue-funded, profitable from day one`);
});