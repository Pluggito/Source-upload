const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");


dotenv.config();
const PORT = process.env.PORT || 5000;

// Validate required environment variables
const requiredEnvVars = ['GEMINI_API_KEY', 'DATABASE_URL'];
const missingEnvVars = requiredEnvVars.filter(envVar => !process.env[envVar]);

if (missingEnvVars.length > 0) {
  console.error('❌ Missing required environment variables:', missingEnvVars);
  process.exit(1);
}

if (!process.env.GEMINI_API_KEY) {
  console.error("🚨 Missing GEMINI_API_KEY in .env file.");
  process.exit(1);
}

const app = express();
app.use(express.json());


// Configure CORS
// Configure CORS
{/*const corsOptions = {
  origin: [
    'https://location-analysis-drab.vercel.app',
    'http://localhost:3000',
    'http://localhost:3001'
  ],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
};

app.use(cors(corsOptions));             // CORS headers for all
app.options('*', cors(corsOptions)); */}

app.use(cors());



app.use('/source', require('./routes/sourceRoutes'))

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});


