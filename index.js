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
      imgSrc: ["'self'", "data:", "https://*.huggingface.co"],
    },
  },
}));

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: process.env.NODE_ENV === 'production' ? 15 : 30,
  message: { error: 'Rate limit exceeded. Try again in a minute.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

// Hugging Face configuration
const HF_API_URL = 'https://api-inference.huggingface.co/models/stabilityai/stable-diffusion-2-1';
const HF_TOKEN = process.env.HUGGINGFACE_TOKEN;

if (!HF_TOKEN) {
  console.error('ERROR: HUGGINGFACE_TOKEN is not set in environment variables');
  process.exit(1);
}

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'AI Text-to-Image API (Hugging Face)',
    version: '2.0.0',
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
      id: 'stable-diffusion-2-1',
      name: 'Stable Diffusion 2.1',
      provider: 'stabilityai',
      max_resolution: '1024x1024',
      free_tier: true
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
      style: 'midjourney-like',
      free_tier: true
    }
  ];
  res.json({ models });
});

// API status
app.get('/api/status', async (req, res) => {
  try {
    const response = await axios.get(HF_API_URL, {
      headers: { Authorization: `Bearer ${HF_TOKEN}` }
    });
    res.json({
      huggingface: 'connected',
      model: response.data.modelId,
      status: 'operational'
    });
  } catch (error) {
    res.status(503).json({
      huggingface: 'disconnected',
      error: 'Cannot connect to Hugging Face'
    });
  }
});

// Main generation endpoint
app.post('/api/generate', async (req, res) => {
  const startTime = Date.now();
  
  try {
    const {
      prompt,
      negative_prompt = '',
      width = 512,
      height = 512,
      num_inference_steps = 30,
      guidance_scale = 7.5,
      model = 'stabilityai/stable-diffusion-2-1'
    } = req.body;

    // Validation
    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({
        error: 'prompt_required',
        message: 'Text prompt is required and must be a string'
      });
    }

    if (prompt.length > 1500) {
      return res.status(400).json({
        error: 'prompt_too_long',
        message: 'Prompt exceeds maximum length of 1500 characters'
      });
    }

    if (width < 64 || height < 64 || width > 1024 || height > 1024) {
      return res.status(400).json({
        error: 'invalid_dimensions',
        message: 'Width and height must be between 64 and 1024 pixels'
      });
    }

    // Prepare Hugging Face request
    const payload = {
      inputs: prompt,
      parameters: {
        negative_prompt: negative_prompt,
        width: parseInt(width),
        height: parseInt(height),
        num_inference_steps: parseInt(num_inference_steps),
        guidance_scale: parseFloat(guidance_scale)
      },
      options: {
        use_cache: true,
        wait_for_model: true
      }
    };

    console.log(`Generating image for: "${prompt.substring(0, 50)}${prompt.length > 50 ? '...' : ''}"`);

    // Call Hugging Face API
    const response = await axios.post(
      `https://api-inference.huggingface.co/models/${model}`,
      payload,
      {
        headers: {
          'Authorization': `Bearer ${HF_TOKEN}`,
          'Content-Type': 'application/json'
        },
        responseType: 'arraybuffer',
        timeout: 60000 // 60 seconds timeout
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
        image: imageUrl, // Base64 encoded image
        model: model,
        dimensions: { width, height },
        generation_time: `${generationTime}ms`,
        timestamp: new Date().toISOString()
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
      if (error.response.status === 401) {
        errorResponse.error = 'invalid_api_token';
        errorResponse.message = 'Hugging Face token is invalid';
        res.status(401);
      } else if (error.response.status === 503) {
        errorResponse.error = 'model_loading';
        errorResponse.message = 'Model is still loading, try again in 30 seconds';
        res.status(503);
      } else if (error.response.status === 429) {
        errorResponse.error = 'rate_limited';
        errorResponse.message = 'Too many requests to Hugging Face';
        res.status(429);
      } else {
        errorResponse.error = 'api_error';
        errorResponse.message = 'Hugging Face API error';
        res.status(502);
      }
    } else if (error.request) {
      // Network error
      errorResponse.error = 'network_error';
      errorResponse.message = 'Cannot connect to Hugging Face';
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

// Batch generation endpoint (for Pro tier)
app.post('/api/generate/batch', async (req, res) => {
  try {
    const { prompts, ...params } = req.body;
    
    if (!Array.isArray(prompts) || prompts.length === 0 || prompts.length > 5) {
      return res.status(400).json({
        error: 'invalid_prompts',
        message: 'Prompts must be an array with 1-5 items'
      });
    }

    const results = [];
    for (const prompt of prompts) {
      try {
        // Reuse single generation logic
        req.body = { prompt, ...params };
        // In real implementation, you'd parallelize this
        results.push({ prompt, status: 'pending', id: Date.now() });
      } catch (err) {
        results.push({ prompt, status: 'failed', error: err.message });
      }
    }

    res.json({
      success: true,
      batch_id: `batch_${Date.now()}`,
      results: results,
      message: 'Batch processing started'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'batch_failed',
      message: error.message
    });
  }
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'endpoint_not_found',
    message: `Cannot ${req.method} ${req.originalUrl}`
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.stack);
  res.status(500).json({
    error: 'internal_error',
    message: 'An unexpected error occurred',
    request_id: req.headers['x-request-id'] || Date.now().toString(36)
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Hugging Face Text-to-Image API running on port ${PORT}`);
  console.log(`🔗 Health check: http://localhost:${PORT}/`);
  console.log(`📝 API Status: http://localhost:${PORT}/api/status`);
  console.log(`⚙️  Environment: ${process.env.NODE_ENV || 'development'}`);
});
