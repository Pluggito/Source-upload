const { OpenAI } = require("openai");
const dotenv = require("dotenv");
dotenv.config();

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

if (!process.env.OPENAI_API_KEY) {
    console.error("🚨 Missing OPENAI_API_KEY in .env file.");
    process.exit(1);
}

const getAiResponse = async (req, res) => {
    const { prompt } = req.body;

    if (!prompt) {
        return res.status(400).json({ error: "Missing 'prompt' in request body." });
    }

    try {
        const completion = await client.chat.completions.create({
            model: "gpt-4o", // ✅ use standard model
            temperature: 0.2,
            response_format: "json", // ✅ force JSON output
            messages: [
                {
                    role: "user",
                    content: prompt
                }
            ]
        });

        const output = completion.choices?.[0]?.message?.content;

        let parsed;
        try {
            parsed = JSON.parse(output);
        } catch (e) {
            parsed = { rawText: output }; // fallback if not strict JSON
        }

        res.status(200).json({ response: parsed });
    } catch (error) {
        console.error("❌ Error fetching AI response:", error);
        res.status(500).json({ error: "Failed to fetch AI response" });
    }
};

module.exports = {
    getAiResponse
};
