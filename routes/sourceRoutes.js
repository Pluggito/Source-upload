const express = require("express");
const router = express.Router();
const multer = require("multer");
const {
  sourceUpload,
  getUpload,
  getLatestUpload,
  getTravelTime,
  enrichAddress,
  getRoute
} = require('../controllers/sourceControllers');


const upload = multer({
  dest: "uploads/",
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
});

router.route('/uploads').post(upload.single("file"), sourceUpload);

// GET: Fetch all uploads
router.route('/results').get(getUpload);

// GET: Fetch latest upload
router.route('/latest').get(getLatestUpload);

router.route('/travel').post(getTravelTime);

router.route('/route').post(getRoute);

module.exports = router;
