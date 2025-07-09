const prisma = require("../lib/prisma");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require("fs");
const pdfParse = require("pdf-parse");
const dotenv = require("dotenv");
const axios = require("axios");
const stateCodes = require("../statecodes.json");
const path = require("path");
const { OpenAI } = require("openai");
const client = new OpenAI();

dotenv.config();
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

//const PORT = process.env.PORT || 5000;
const DEBUG_WRITE = process.env.DEBUG_WRITE === "true"; // toggle saving output

// Ensure the storage directory exists
const storageDir = "./storage";
if (!fs.existsSync(storageDir)) {
  fs.mkdirSync(storageDir);
}

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const enrichAddress = async (req, res, next) => {
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
      return res
        .status(400)
        .json({ error: "Incomplete address data from AI." });
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

    res.json({
      success: true,
      message: "Address enriched and saved.",
      geoData,
    });
  } catch (err) {
    console.error("❌ Address enrichment error:", err.message || err.stack);
    res.status(500).json({
      error: "Failed to extract/enrich address.",
      details: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }

  next();
};

// Source upload handler
// This function processes the uploaded PDF, extracts text, and generates structured JSON using Gemini AI

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

// Get the latest upload from the database
// This function retrieves the most recent GeminiResponse entry and checks for completeness

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

// Get travel times using OpenRouteService API
// This function calculates travel times from a start coordinate to multiple end coordinates using ORS Matrix API

const getTravelTime = async (req, res) => {
  const { start, ends } = req.body;

  if (!start || !ends || !Array.isArray(ends) || ends.length === 0) {
    return res
      .status(400)
      .json({ error: "Missing start coordinate or ends array" });
  }

  try {
    // Build locations array: first is start, then all ends
    const locations = [start, ...ends];

    // sources = [0] (start)
    // destinations = [1, 2, ..., ends.length]
    const destinations = ends.map((_, i) => i + 1);

    const orsRes = await axios.post(
      "https://api.openrouteservice.org/v2/matrix/driving-car",
      {
        locations,
        sources: [0],
        destinations,
        metrics: ["duration", "distance"],
      },
      {
        headers: {
          Authorization: process.env.ORS_API_KEY,
          "Content-Type": "application/json",
        },
      }
    );

    res.status(200).json({
      durations: orsRes.data.durations[0], // times from start to each destination
      distances: orsRes.data.distances[0], // distances from start to each destination
    });
  } catch (error) {
    if (error.response) {
      console.error("ORS Error:", error.response.data);
      return res.status(error.response.status).json({
        error: "ORS request failed",
        details: error.response.data,
      });
    }
    console.error("API Error:", error.message);
    res.status(500).json({ error: "Server error" });
  }
};

//Get travel times using TomTom API
// This function calculates the route between a start and end coordinate using TomTom's Routing API

const getRoute = async (req, res) => {
  let { start, end } = req.body;

  // Handle string coordinates: "40.6793,-74.016"
  if (typeof start === "string") {
    start = start.split(",").map((coord) => parseFloat(coord.trim()));
  }

  if (typeof end === "string") {
    end = end.split(",").map((coord) => parseFloat(coord.trim()));
  }

  // Validate
  if (
    !Array.isArray(start) ||
    start.length !== 2 ||
    start.some(isNaN) ||
    !Array.isArray(end) ||
    end.length !== 2 ||
    end.some(isNaN)
  ) {
    return res
      .status(400)
      .json({ error: "Missing or invalid start or end coordinates" });
  }

  if (!process.env.TOMTOM_API_KEY) {
    return res.status(500).json({ error: "TOMTOM_API_KEY is not set" });
  }

  try {
    const url = `https://api.tomtom.com/routing/1/calculateRoute/${start[0]},${start[1]}:${end[0]},${end[1]}/json?key=${process.env.TOMTOM_API_KEY}&computeBestOrder=true&routeType=fastest&travelMode=car&traffic=true`;

    const tomtomRes = await axios.get(url);

    if (
      !tomtomRes.data ||
      !tomtomRes.data.routes ||
      tomtomRes.data.routes.length === 0
    ) {
      return res.status(404).json({ error: "No route found" });
    }

    const route = tomtomRes.data.routes[0];
    res.status(200).json({
      distance: route.summary.lengthInMeters,
      duration: route.summary.travelTimeInSeconds,
      polyline: route.legs[0].points.map((p) => [p.latitude, p.longitude]),
    });

    console.log("Route fetched successfully:", {
      distance: route.summary.lengthInMeters,
      duration: route.summary.travelTimeInSeconds,
    });
  } catch (error) {
    if (error.response) {
      console.error("TomTom Error:", error.response.data);
      return res.status(error.response.status).json({
        error: "TomTom request failed",
        details: error.response.data,
      });
    }
    console.error("API Error:", error.message);
    res.status(500).json({ error: "Server error" });
  }
};

//Get the address information using the US Census Geocoding API
// This function retrieves county FIPS codes and GEOIDs based on a provided address
//The address should include street number, street name, city, and state
// The address is gotten to run other api calls to get the latest warehouse wages, unemployment rate, consumer spending, incentives, and utility rates
// The address is expected to be in the format: "123 Main St, Springfield, IL

const combinedData = {};

const getAddress = async (req, res, next) => {
  const { streetNumber, streetName, city, state, zipCode } = req.body;

  if (!streetNumber || !streetName || !city || !state || !zipCode) {
    return res.status(400).json({ error: "All address fields are required" });
  }

  try {
    const response = await axios.get(
      `https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress`,
      {
        params: {
          address: `${streetNumber} ${streetName} ${city}, ${state}`,
          benchmark: "Public_AR_Current",
          vintage: "Current_Current",
          format: "json",
        },
      }
    );

    const addressMatch = response.data.result?.addressMatches?.[0];
    const countyGeo = addressMatch?.geographies?.Counties?.[0];

    if (!countyGeo) {
      return res.status(404).json({ error: "County information not found" });
    }

    combinedData.address = {
      stateFIPS: countyGeo.STATE,
      countyFIPS: countyGeo.COUNTY,
      fullCountyGEOID: countyGeo.GEOID,
    };

    next();
  } catch (error) {
    return res.status(500).json({ error: "Address fetch failed" });
  }
};

const getLatestWarehouseWages = async (req, res, next) => {
  const { stateFIPS, countyFIPS, fullCountyGEOID } = combinedData.address;

  if (!stateFIPS || !countyFIPS || !fullCountyGEOID) {
    return res.status(400).json({ error: "Address information is incomplete" });
  }

  const occupationSOC = "537062"; // SOC for warehouse workers

  // Find the state entry that matches the state FIPS
  const matchedStateCode = stateCodes.find((state) => state.fips === stateFIPS);

  if (!matchedStateCode || !matchedStateCode.areaCode) {
    return res.status(400).json({ error: "State area code not found" });
  }

  if (!process.env.BLS_API_KEY) {
    return res.status(500).json({ error: "BLS_API_KEY is not set" });
  }

  try {
    const seriesId = `OEUM${matchedStateCode.areaCode}000000${occupationSOC}03`;
    console.log("BLS Series ID:", seriesId);

    const { data } = await axios.post(
      "https://api.bls.gov/publicAPI/v2/timeseries/data",
      {
        seriesid: [seriesId],
        startyear: "2024",
        endyear: "2024",
        registrationKey: process.env.BLS_API_KEY,
      }
    );

    const wageValue = data?.Results?.series?.[0]?.data?.[0]?.value;

    if (!wageValue) {
      return res.status(404).json({ error: "No warehouse wage data found" });
    }

    combinedData.warehouseWagesPerHour = wageValue;
    next();
  } catch (error) {
    console.error("BLS API error:", error.message);
    return res.status(500).json({ error: "Internal server error" });
  }
};

//Get the latest unemployment rate using the BLS API
const getlatestUnemploymentRate = async (req, res, next) => {
  const { stateFIPS, countyFIPS, fullCountyGEOID } = combinedData.address;

  if (!stateFIPS || !countyFIPS || !fullCountyGEOID) {
    return res.status(400).json({ error: "Address information is incomplete" });
  }

  if (!process.env.BLS_API_KEY) {
    return res.status(500).json({ error: "BLS_API_KEY is not set" });
  }

  try {
    const seriesId = `LAUCN${stateFIPS}${countyFIPS}0000000003`;

    const { data } = await axios.post(
      "https://api.bls.gov/publicAPI/v2/timeseries/data",
      {
        seriesid: [seriesId],
        startyear: "2020",
        endyear: "2025",
        registrationKey: process.env.BLS_API_KEY,
        calculations: true,
      }
    );

    const series = data?.Results?.series?.[0];

    if (!series || !series.data || series.data.length === 0) {
      return res.status(404).json({ error: "No unemployment rate data found" });
    }

    // Optional: Catalog info
    const catalog = {
      series_title: series.catalog?.series_title || "Unemployment Rate",
      series_id: series.seriesID,
      area: series.catalog?.area,
      area_type: series.catalog?.area_type,
      survey_name: series.catalog?.survey_name,
      measure_data_type: series.catalog?.measure_data_type,
    };

    // Format all unemployment rate entries
    const formattedUnemploymentRate = series.data.map((entry) => ({
      year: entry.year,
      period: entry.period,
      periodName: entry.periodName,
      latest: entry.latest || false,
      value: entry.value,
      footnotes: entry.footnotes || [],
      calculations: entry.calculations || {},
    }));

    // Store both metadata and time series data
    combinedData.unemploymentRate = {
      catalog,
      data: formattedUnemploymentRate,
    };

    next();
  } catch (error) {
    console.error("BLS API error:", error.message);
    return res.status(500).json({ error: "Internal server error" });
  }
};

//Get the latest employment Data using the BLS API
const getLatestEmploymentData = async (req, res, next) => {
  const { stateFIPS, countyFIPS, fullCountyGEOID } = combinedData.address;

  if (!stateFIPS || !countyFIPS || !fullCountyGEOID) {
    return res.status(400).json({ error: "Address information is incomplete" });
  }

  if (!process.env.BLS_API_KEY) {
    return res.status(500).json({ error: "BLS_API_KEY is not set" });
  }

  try {
    const seriesId = `LAUCN${stateFIPS}${countyFIPS}0000000005`; // Series ID for employment data

    const { data } = await axios.post(
      "https://api.bls.gov/publicAPI/v2/timeseries/data",
      {
        seriesid: [seriesId],
        startyear: "2020",
        endyear: "2025",
        registrationKey: process.env.BLS_API_KEY,
        calculations: true,
      }
    );

    const series = data?.Results?.series?.[0];

    if (!series || !series.data || series.data.length === 0) {
      return res.status(404).json({ error: "No unemployment rate data found" });
    }

    const catalog = {
      series_title: series.catalog?.series_title || "Unemployment Rate",
      series_id: series.seriesID,
      area: series.catalog?.area,
      area_type: series.catalog?.area_type,
      survey_name: series.catalog?.survey_name,
      measure_data_type: series.catalog?.measure_data_type,
    };

    // Format all employment data entries
    const formattedemploymentData = series.data.map((entry) => ({
      year: entry.year,
      period: entry.period,
      periodName: entry.periodName,
      latest: entry.latest || false,
      value: entry.value,
      footnotes: entry.footnotes || [],
      calculations: entry.calculations || {},
    }));

    // Store both metadata and time series data
    combinedData.employmentData = {
      catalog,
      data: formattedemploymentData,
    };

    next(); //continue to next middleware
  } catch (error) {
    console.error("BLS API error:", error.message);
    return res.status(500).json({ error: "Internal server error" });
  }
};

const getLatestUnEmploymentData = async (req, res, next) => {
  const { stateFIPS, countyFIPS, fullCountyGEOID } = combinedData.address;

  if (!stateFIPS || !countyFIPS || !fullCountyGEOID) {
    return res.status(400).json({ error: "Address information is incomplete" });
  }

  if (!process.env.BLS_API_KEY) {
    return res.status(500).json({ error: "BLS_API_KEY is not set" });
  }

  try {
    const seriesId = `LAUCN${stateFIPS}${countyFIPS}0000000004`; // Series ID for employment data

    const { data } = await axios.post(
      "https://api.bls.gov/publicAPI/v2/timeseries/data",
      {
        seriesid: [seriesId],
        startyear: "2020",
        endyear: "2025",
        registrationKey: process.env.BLS_API_KEY,
        calculations: true,
      }
    );

    const series = data?.Results?.series?.[0];

    if (!series || !series.data || series.data.length === 0) {
      return res.status(404).json({ error: "No unemployment rate data found" });
    }

    const catalog = {
      series_title: series.catalog?.series_title || "Unemployment Rate",
      series_id: series.seriesID,
      area: series.catalog?.area,
      area_type: series.catalog?.area_type,
      survey_name: series.catalog?.survey_name,
      measure_data_type: series.catalog?.measure_data_type,
    };

    // Format all unemployment data entries
    const formattedunemploymentData = series.data.map((entry) => ({
      year: entry.year,
      period: entry.period,
      periodName: entry.periodName,
      latest: entry.latest || false,
      value: entry.value,
      footnotes: entry.footnotes || [],
      calculations: entry.calculations || {},
    }));

    // Store both metadata and time series data
    combinedData.unemploymentData = {
      catalog,
      data: formattedunemploymentData,
    };

    next(); //continue to next middleware
  } catch (error) {
    console.error("BLS API error:", error.message);
    return res.status(500).json({ error: "Internal server error" });
  }
};


const getPopulationTrends = async (req, res, next) => {
  const { stateFIPS, countyFIPS, fullCountyGEOID } = combinedData.address;

  if (!stateFIPS || !countyFIPS || !fullCountyGEOID) {
    return res.status(400).json({ error: "Address information is incomplete" });
  }

  const years = [2014, 2015, 2016, 2017, 2018, 2019, 2021, 2022, 2023];
  const trends = [];

  for (const year of years) {
    try {
      const response = await axios.get(
        `https://api.census.gov/data/${year}/acs/acs1?get=B01003_001E&for=county:${countyFIPS}&in=state:${stateFIPS}`
      );

      if (response.data && response.data.length > 1) {
        const population = parseInt(response.data[1][0], 10);
        trends.push({ year, population });
      } else {
        console.warn(`No data for ${year} in county ${countyFIPS}`);
        trends.push({ year, population: null });
      }
    } catch (error) {
      console.error(`Error fetching data for ${year}:`, error.message);
      trends.push({ year, population: null });
    }
  }

  // Attach to shared data
  combinedData.populationTrends = trends;

  // Now call next once
  next();
};


const getMedianIncome = async (req, res, next) => {
    const { stateFIPS, countyFIPS, fullCountyGEOID } = combinedData.address;

  if (!stateFIPS || !countyFIPS || !fullCountyGEOID) {
    return res.status(400).json({ error: "Address information is incomplete" });
  }
  
  const years = [2015, 2016, 2017, 2018, 2019, 2021, 2022, 2023];
  const trends = [];

  for (const year of years) {
    try {
      const response = await axios.get(
        `https://api.census.gov/data/${year}/acs/acs1?get=B19013_001E&for=county:${countyFIPS}&in=state:${stateFIPS}`
      );

      if (response.data && response.data.length > 1) {
        const medianIncome = parseInt(response.data[1][0], 10);
        trends.push({ year, medianIncome });
      } else {
        console.warn(`No data for ${year} in county ${countyFIPS}`);
        trends.push({ year, medianIncome: null });
      }
    } catch (error) {
      console.error(`Error fetching data for ${year}:`, error.message);
      trends.push({ year, medianIncome: null });
    }
  }

  // Attach to shared data
  combinedData.medianIncomeTrends = trends;

  // Now call next once
  next();

}

//Get the latest consumer spending data using the BLS API
// This function retrieves the latest consumer spending data for a given address using the BLS API
const getlatestConsumerSpending = async (req, res, next) => {
  const { stateFIPS, countyFIPS, fullCountyGEOID } = combinedData.address;

  if (!stateFIPS || !countyFIPS || !fullCountyGEOID) {
    return res.status(400).json({ error: "Address information is incomplete" });
  }

  if (!process.env.BLS_API_KEY) {
    return res.status(500).json({ error: "BLS_API_KEY is not set" });
  }

  try {
    const seriesId = `CUSR0000SA0`;

    const { data } = await axios.post(
      "https://api.bls.gov/publicAPI/v2/timeseries/data",
      {
        seriesid: [seriesId],
        startyear: "2015",
        endyear: "2024",
        registrationKey: process.env.BLS_API_KEY,
      }
    );

    const consumerSpendingData = data?.Results?.series?.[0]?.data;

    if (!consumerSpendingData) {
      return res.status(404).json({ error: "No consumer spending data found" });
    }

    combinedData.consumerSpending = consumerSpendingData;
    next();
  } catch (error) {
    console.error("BLS API error:", error.message);
    return res.status(500).json({ error: "Internal server error" });
  }
};

//Using chagpt-4 to extract the latest federal tax incentives from IRS.gov
// This function fetches the latest commercial tax incentives from IRS.gov using OpenAI's API
const getlatestIncentives = (req, res, next) => {
  if (!process.env.OPENAI_API_KEY) {
    console.error("🚨 Missing OPENAI_API_KEY in .env file.");
    return res.status(500).json({ error: "Internal server error" });
  }

  // Ensure the request body contains the necessary data
  const prompt =
    "Visit https://www.irs.gov/credits-deductions and extract all current commercial or business-related federal tax credits. Return strict JSON only array where each object includes: name, type, description, impact_per_sf (if any), expandable_bullets, urls and action_required, without markdown or backticks. Only return the raw JSON object. Focus on incentives like 179D, NMTC, or R&D Credit.";

  client.chat.completions
    .create({
      model: "gpt-4o-search-preview",
      web_search_options: {},
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
    })
    .then((completion) => {
      // If you want to parse the output as JSON, do it here
      let output = completion.choices?.[0]?.message?.content;

      let parsed;
      try {
        // Strip markdown code block if present
        const cleaned = output
          .replace(/```json\n?/, "") // Remove starting markdown block
          .replace(/```$/, "") // Remove ending markdown block
          .trim();

        parsed = JSON.parse(cleaned);
      } catch (e) {
        parsed = { rawText: output }; // fallback if it's still not strict JSON
      }

      combinedData.incentives = parsed;
      next(); // continue to next middleware
    })
    .catch((error) => {
      console.error("Error fetching AI response:", error);
      res.status(500).json({ error: "Failed to fetch AI response" });
    });
};

const getlatestUtilityRates = async (req, res, next) => {
  try {
    const filePath = path.join(process.cwd(), "utilitiesRatesAndPremiums.json");

    if (!fs.existsSync(filePath)) {
      return res
        .status(404)
        .json({ error: "Utility rates document not found" });
    }

    const fileContent = fs.readFileSync(filePath, "utf-8");

    const data = JSON.parse(fileContent);

    combinedData.utilityRates = data;
    next(); // continue to next middleware
  } catch (err) {
    console.error("Error loading utility rates file:", err.message);
    return res.status(500).json({ error: "Failed to load utility rate data" });
  }
};

// ✅ Final handler: return full response
const returnFinalData = async (req, res) => {
  await prisma.EconomicsData.create({
    data: {
      address: combinedData.address,
      warehouseWagesPerHour: combinedData.warehouseWagesPerHour,
      employmentData: combinedData.employmentData,
      unemploymentData: combinedData.unemploymentData,
      unemploymentRate: combinedData.unemploymentRate,
      consumerSpending: combinedData.consumerSpending,
      populationTrends: combinedData.populationTrends,
      medianIncomeTrends: combinedData.medianIncomeTrends, 
      incentives: combinedData.incentives,
      utilityRates: combinedData.utilityRates,
    },
  });

  res.status(200).json({
    message: "All data fetched successfully",
    data: combinedData,
  });
};

const getUpdatedData = async (req, res) => {
  try {
    const data = await prisma.EconomicsData.findFirst({
      orderBy: {
        createdAt: "desc",
      },
    });
    if (!data) {
      return res.status(404).json({ error: "No data found" });
    }
    res.status(200).json({
      message: "Latest economic data fetched successfully",
      data,
    });
  } catch (error) {
    console.error("Error fetching latest economic data:", error);
    res.status(500).json({ error: "Failed to fetch latest economic data" });
  }
};

module.exports = {
  getUpload,
  getLatestUpload,
  sourceUpload,
  getTravelTime,
  getRoute,
  getLatestWarehouseWages,
  getlatestUnemploymentRate,
  getlatestConsumerSpending,
  getPopulationTrends,
  getMedianIncome,
  getlatestIncentives,
  getlatestUtilityRates,
  getLatestEmploymentData,
  getLatestUnEmploymentData,
  getAddress,
  returnFinalData,
  getUpdatedData,
};
