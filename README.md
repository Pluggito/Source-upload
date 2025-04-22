# 🧠 Source-upload

A backend service to upload real estate PDFs, extract information using Gemini AI, and return structured JSON for frontend display.

---

## 🚀 Features

- Upload PDF files
- Automatically extract relevant insights via Gemini AI
- Store and retrieve parsed data using PostgreSQL and Prisma
- RESTful API endpoints for uploading and fetching results

---

## 💠 Setup Instructions

### 1. Clone the repo

```bash
git clone https://github.com/your-username/source-upload.git
cd source-upload
```

### 2. Install dependencies

```bash
npm install
```

### 3. Set up environment variables

Create a `.env` file in the root:

```env
PORT=5000
DATABASE_URL=your_postgres_connection_url
GEMINI_API_KEY=your_gemini_api_key
```

### 4. Initialize the database

```bash
npx prisma generate
npx prisma migrate dev --name init
```

---

## 🧪 Running the App

```bash
npm start
```

The server should be running at: `http://localhost:5000`

---

## 📤 API Endpoints

### POST `/upload`

Upload a PDF file:

- **Form field**: `file`
- **Response**: AI-parsed JSON data

### GET `/results/latest`

Returns the latest extracted JSON result.

### GET `/data/latest`

Returns the saved data from the database.

---

## 📎 Folder Structure

```txt
generated/prisma/     # Auto-generated Prisma client
lib/                  # AI utility functions and helpers
prisma/               # Prisma schema and migrations
storage/              # Temporary file storage
uploads/              # Uploaded PDF files
index.js              # Entry point of the backend
```

---

## 🧠 Notes

- AI parsing is handled via Gemini 2.0 flash.
- Deployed via Render (adjust database credentials accordingly).

---

