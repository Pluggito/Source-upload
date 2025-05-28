const express = require("express");
const router = express.Router();
const multer = require("multer");
const {
  sourceUpload,
  getUpload,
  getLatestUplaod,
  enrishAddress
} = require('../controllers/sourceControllers');


const upload = multer({
  dest: "uploads/",
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
}); 

// POST: First enrich the address, then upload
router.route('/uploads').post(upload.single("file"), sourceUpload);

// GET: Fetch all uploads
router.route('/results').get(getUpload);

// GET: Fetch latest upload
router.route('/latest').get(getLatestUplaod);

module.exports = router;
