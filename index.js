const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const pdfParse = require("pdf-parse");
const dotenv = require("dotenv");
const axios = require("axios");
const prisma = require("./lib/prisma");

dotenv.config();

// Validate required environment variables
const requiredEnvVars = ['LLAMA_API_KEY', 'DATABASE_URL'];
const missingEnvVars = requiredEnvVars.filter(envVar => !process.env[envVar]);

if (missingEnvVars.length > 0) {
  console.error('❌ Missing required environment variables:', missingEnvVars);
  process.exit(1);
}

const app = express();

// Configure CORS
app.use(cors({
  origin: ['https://location-analysis-drab.vercel.app', 'http://localhost:3000'],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

const upload = multer({
  dest: "uploads/",
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
});
const PORT = process.env.PORT || 5000;
const DEBUG_WRITE = process.env.DEBUG_WRITE === "true"; // toggle saving output

// Ensure the storage directory exists
const storageDir = "./storage";
if (!fs.existsSync(storageDir)) {
  fs.mkdirSync(storageDir);
}

app.post("/upload", upload.single("file"), async (req, res) => {
  const file = req.file;

  if (!file || file.mimetype !== "application/pdf") {
    return res.status(400).json({ error: "Invalid file type. PDF required." });
  }

  let buffer, pdfText;
  try {
    buffer = fs.readFileSync(file.path);
    const pdfData = await pdfParse(buffer);
    pdfText = pdfData.text;
  } catch (err) {
    console.error("❌ Failed to parse PDF:", err.stack || err.message);
    return res.status(500).json({ error: "Error parsing PDF file." });
  } finally {
    fs.unlink(file.path, (err) => {
      if (err) console.warn("⚠️ Failed to delete uploaded file:", err.message);
    });
  }

  const prompt = `
Analyze this real estate document and return a complete and structured JSON object strictly matching the following format. Ensure all sections are included, even if some values are null or empty. Do not omit any fields.

1. supply_pipeline: {
  nearby_developments: {
  supply: string;
  name: string;
  description: string;
  tenant: string;}[],
  construction_timelines: { project: string;
  completion: string;
  name: string;
  address: string;
  distance: string;
  status: string;
  progress: number;
  size: string;
  type: string;
  developer: string;
  tenant: string;
  description: string}[],
  property_type_mix: { type: string, percentage: number }[]
}

2. land_sale_comparables: {
  price_per_sqft: number,
  zoning: string,
  parcel_size: string[],
  recent_sales: { 
  address: string, 
  price: number, 
  date: string, 
  size: number, 
  buyers: string, 
  price_psf: number, 
  submarket: string, 
  cap_rate: string, 
  tenant: string 
}[]

}

3. demographic_trends: {
  population_growth:{insights: string, description: string, year: string, capital: string,  population: number, state: string}[],
  income: {insights: string, description: string, income: number, year: string}[],
  spending: {insights: string, description: string, amount: number, category: string}[],
}

4. proximity_insights: {
  highways: {state: string, sign: number,  name: string, distance: string time-traveled: string}[],
  ports: { name: string, distance: string, insights: string }[],
  airports: { name: string, distance: string }[],
  major_tenants: { name:string, company: string }[],
  key_location: {location: string, distance: number, time: number, insight: string}[]
}

5. zoning_overlays: {
  code: string[],
  description: string[],
  municipal_reference: string[],
  link: string[]
}[]

- Carefully extract and map the relevant data from the PDF to this format.
- Return only valid JSON and  PDF Content:
  ${pdfText}
  `;

  let aiResponse, cleanJSON;
  try {
    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama3-70b-8192',
        messages: [
          {
            role: 'system',
            content: 'You are a helpful assistant that analyzes real estate documents and returns structured JSON data. You are precise and accurate in your analysis.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.3,
        max_tokens: 4000,
        top_p: 0.9,
        frequency_penalty: 0.0,
        presence_penalty: 0.0
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.LLAMA_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    aiResponse = response.data.choices[0].message.content.trim();
    cleanJSON = safeParseJSON(aiResponse);

    if (!isStructuredJSON(cleanJSON)) {
      console.error("❌ Invalid JSON structure:", cleanJSON);
      throw new Error("AI returned unstructured or incomplete JSON.");
    }

    await prisma.geminiResponse.create({
      data: {
        supplyPipeline: cleanJSON.supply_pipeline,
        landSaleComparables: cleanJSON.land_sale_comparables,
        demographicTrends: cleanJSON.demographic_trends,
        proximityInsights: cleanJSON.proximity_insights,
        zoningOverlays: cleanJSON.zoning_overlays,
      },
    });

    if (DEBUG_WRITE) {
      const outputPath = `${storageDir}/parsed-${Date.now()}.json`;
      fs.writeFileSync(outputPath, JSON.stringify(cleanJSON, null, 2));
    }

    res.json({ success: true, data: cleanJSON });
  } catch (err) {
    console.error("❌ Error details:", {
      message: err.message,
      stack: err.stack,
      response: aiResponse,
      cleanJSON: cleanJSON
    });
    
    res.status(500).json({ 
      error: "Failed to process file or generate structured data.",
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

app.get("/results", async (req, res) => {
  try {
    const results = await prisma.geminiResponse.findMany({
      orderBy: { createdAt: "desc" },
    });
    res.json({ success: true, results });
  } catch (err) {
    console.error("❌ Failed to fetch results:", err.stack || err.message);
    res.status(500).json({ error: "Failed to fetch results." });
  }
});

app.get("/data/latest", async (req, res) => {
  try {
    const latest = await prisma.geminiResponse.findFirst({
      orderBy: {
        createdAt: "desc",
      },
    });

    if (!latest) {
      return res.status(404).json({ error: "No data found" });
    }

    // Ensure all required fields are present
    if (!latest.supplyPipeline || !latest.landSaleComparables || 
        !latest.demographicTrends || !latest.proximityInsights || 
        !latest.zoningOverlays) {
      return res.status(500).json({ 
        error: "Incomplete data structure in database" 
      });
    }

    res.json(latest);
  } catch (err) {
    console.error("❌ Failed to fetch data:", err);
    res.status(500).json({ 
      error: "Failed to fetch data",
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});


app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});

// Parse and clean JSON from AI response
function safeParseJSON(text) {
  try {
    const cleaned = text
      .replace(/^```json/, "")
      .replace(/```$/, "")
      .trim();
    return JSON.parse(cleaned);
  } catch (err) {
    console.warn("⚠️ Could not parse JSON, returning raw:", err.message);
    return { raw: text };
  }
}

// Basic structural check for expected JSON format
function isStructuredJSON(json) {
  return (
    json &&
    typeof json === "object" &&
    "supply_pipeline" in json &&
    "land_sale_comparables" in json &&
    "demographic_trends" in json &&
    "proximity_insights" in json &&
    "zoning_overlays" in json
  );
}
