const prisma = require("../lib/prisma");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require("fs");
const pdfParse = require("pdf-parse");
const dotenv = require("dotenv");
const axios = require('axios');

dotenv.config();
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);


//const PORT = process.env.PORT || 5000;
const DEBUG_WRITE = process.env.DEBUG_WRITE === "true"; // toggle saving output

// Ensure the storage directory exists
const storageDir = "./storage";
if (!fs.existsSync(storageDir)) {
  fs.mkdirSync(storageDir);
}

const enrishAddress = async (req, res, next) => {
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

  const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
  const prompt = `
Extract the address from this real estate PDF and return JSON like:
{
  "houseNumber": "280",
  "streetName": "Richard Street",
  "borough": "Brooklyn",
  "zip": "11208"
}

PDF:
${pdfText.slice(0, 12000)}
`;

  try {
    const result = await model.generateContent(prompt);
    const aiResponse = result.response.text().trim();
    const address = safeParseJSON(aiResponse);

    if (!address?.houseNumber || !address?.streetName || !address?.borough) {
      return res.status(400).json({ error: "Incomplete address data from AI." });
    }

    // 🛰 Fetch enriched data from NYC Geoclient API
    const query = new URLSearchParams({
      houseNumber: address.houseNumber,
      street: address.streetName,
      borough: address.borough,
      zip: address.zip ?? "", // optional
    });

    const geoRes = await fetch(
      `https://api.nyc.gov/geoclient/v2/address.json?${query.toString()}`,
      {
        headers: { "Ocp-Apim-Subscription-Key": process.env.NYC_GEO_KEY },
      }
    );

    const geoData = await geoRes.json();

    // 🗂 Save to DB
    await prisma.address.create({
      data: {
        datasource: geoData,
      },
    });

    res.json({ success: true, message: "Address enriched and saved.", geoData });
  } catch (err) {
    console.error("❌ Address enrichment error:", err.message || err.stack);
    res.status(500).json({
      error: "Failed to extract/enrich address.",
      details: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }

  next()
};


const sourceUpload = async (req, res) => {
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

  const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
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
    const result = await model.generateContent(
      `${prompt}\n\n${pdfText.slice(0, 12000)}`
    );
    aiResponse = result.response.text().trim();
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
      cleanJSON: cleanJSON,
    });

    res.status(500).json({
      error: "Failed to process file or generate structured data.",
      details: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }
}; 


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


const getUpload = async (req, res) => {
  try {
    const results = await prisma.geminiResponse.findMany({
      orderBy: { createdAt: "desc" },
    });
    res.json({ success: true, results });
  } catch (err) {
    console.error("❌ Failed to fetch results:", err.stack || err.message);
    res.status(500).json({ error: "Failed to fetch results." });
  }
};

const getLatestUpload = async (req, res) => {
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
    if (
      !latest.supplyPipeline ||
      !latest.landSaleComparables ||
      !latest.demographicTrends ||
      !latest.proximityInsights ||
      !latest.zoningOverlays
    ) {
      return res.status(500).json({
        error: "Incomplete data structure in database",
      });
    }

    res.json(latest);
  } catch (err) {
    console.error("❌ Failed to fetch data:", err);
    res.status(500).json({
      error: "Failed to fetch data",
      details: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }
};

const getTravelTime = async (req, res) => {
  const { start, ends } = req.body;

  if (!start || !ends || !Array.isArray(ends) || ends.length === 0) {
    return res.status(400).json({ error: 'Missing start coordinate or ends array' });
  }

  try {
    // Build locations array: first is start, then all ends
    const locations = [start, ...ends];

    // sources = [0] (start)
    // destinations = [1, 2, ..., ends.length]
    const destinations = ends.map((_, i) => i + 1);

    const orsRes = await axios.post(
      'https://api.openrouteservice.org/v2/matrix/driving-car',
      {
        locations,
        sources: [0],
        destinations,
        metrics: ['duration', 'distance'],
      },
      {
        headers: {
          Authorization: process.env.ORS_API_KEY,
          'Content-Type': 'application/json',
        },
      }
    );

    res.status(200).json({
      durations: orsRes.data.durations[0],   // times from start to each destination
      distances: orsRes.data.distances[0],   // distances from start to each destination
    });
  } catch (error) {
    if (error.response) {
      console.error('ORS Error:', error.response.data);
      return res.status(error.response.status).json({
        error: 'ORS request failed',
        details: error.response.data,
      });
    }
    console.error('API Error:', error.message);
    res.status(500).json({ error: 'Server error' });
  }
};

const getRoute = async (req, res) => {
  let { start, end } = req.body;

  // Handle string coordinates: "40.6793,-74.016"
  if (typeof start === 'string') {
    start = start.split(',').map(coord => parseFloat(coord.trim()));
  }

  if (typeof end === 'string') {
    end = end.split(',').map(coord => parseFloat(coord.trim()));
  }

  // Validate
  if (
    !Array.isArray(start) || start.length !== 2 || start.some(isNaN) ||
    !Array.isArray(end) || end.length !== 2 || end.some(isNaN)
  ) {
    return res.status(400).json({ error: 'Missing or invalid start or end coordinates' });
  }

  
if (!process.env.TOMTOM_API_KEY) {  
  return res.status(500).json({ error: 'TOMTOM_API_KEY is not set' });
}


  try {
    const url = `https://api.tomtom.com/routing/1/calculateRoute/${start[0]},${start[1]}:${end[0]},${end[1]}/json?key=${process.env.TOMTOM_API_KEY}&computeBestOrder=true&routeType=fastest&travelMode=car&traffic=true`;

    const tomtomRes = await axios.get(url);

    if (!tomtomRes.data || !tomtomRes.data.routes || tomtomRes.data.routes.length === 0) {
      return res.status(404).json({ error: 'No route found' });
    }

    const route = tomtomRes.data.routes[0];
    res.status(200).json({
      distance: route.summary.lengthInMeters,
      duration: route.summary.travelTimeInSeconds,
      polyline: route.legs[0].points.map(p => [p.latitude, p.longitude]),
    });

    console.log('Route fetched successfully:', {
      distance: route.summary.lengthInMeters,
      duration: route.summary.travelTimeInSeconds,
    });
  }
  catch (error) {
    if (error.response) {
      console.error('TomTom Error:', error.response.data);
      return res.status(error.response.status).json({
        error: 'TomTom request failed',
        details: error.response.data,
      });
    }
    console.error('API Error:', error.message);
    res.status(500).json({ error: 'Server error' });
  }
};

module.exports = {  getUpload, getLatestUpload, sourceUpload, getTravelTime, getRoute};
