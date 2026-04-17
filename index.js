const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const nodemailer = require('nodemailer');
const twilio = require('twilio');
const axios = require('axios'); // Add this for downloading images from URL

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;

// Proper CORS for production
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST']
}));
app.use(express.json({ limit: '50mb' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Ensure uploads folder exists
if (!fs.existsSync('./uploads')) {
  fs.mkdirSync('./uploads');
}

// MongoDB Connection
const MONGO_URI = process.env.MONGO_URI;

console.log('Attempting to connect to MongoDB...');

if (!MONGO_URI) {
  console.error('❌ MONGO_URI is missing in Railway Variables');
  process.exit(1);
}

mongoose.connect(MONGO_URI, {
  serverSelectionTimeoutMS: 10000
})
  .then(() => console.log('✅ Connected to MongoDB Successfully'))
  .catch(err => {
    console.error('❌ MongoDB connection error:', err.message);
    process.exit(1);
  });

app.get("/", (req, res) => {
  res.send("Backend is running");
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// Schema
const userSchema = new mongoose.Schema({
  fullName: String,
  phone: String,
  gmail: String,
  lastPhotoPath: String,
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);

// Registration Route
app.post('/api/register-simple', async (req, res) => {
  try {
    const { fullName, phone, gmail } = req.body;
    if (!fullName || !phone || !gmail) {
      return res.status(400).json({ message: 'All fields are required' });
    }
    const newUser = new User({ fullName, phone, gmail });
    await newUser.save();
    res.status(201).json({ user: newUser, message: 'Registration successful' });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Photo Upload Route
app.post('/api/upload-photo', async (req, res) => {
  try {
    const { userId, image } = req.body;
    if (!userId || !image) {
      return res.status(400).json({ message: 'Missing data' });
    }

    const base64Data = image.replace(/^data:image\/\w+;base64,/, "");
    const filename = `${uuidv4()}.png`;
    const filepath = path.join(__dirname, 'uploads', filename);
    
    fs.writeFileSync(filepath, base64Data, 'base64');

    const photoUrl = `/uploads/${filename}`;
    await User.findByIdAndUpdate(userId, { lastPhotoPath: photoUrl });

    res.status(200).json({ photoUrl });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Helper function to download image from URL
async function downloadImage(url, outputPath) {
  try {
    // Handle both local and remote URLs
    if (url.startsWith('http')) {
      const response = await axios({
        method: 'GET',
        url: url,
        responseType: 'stream'
      });
      
      const writer = fs.createWriteStream(outputPath);
      response.data.pipe(writer);
      
      return new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
      });
    } else if (url.startsWith('/uploads/')) {
      // Local file
      const localPath = path.join(__dirname, url);
      fs.copyFileSync(localPath, outputPath);
      return Promise.resolve();
    } else {
      throw new Error('Unsupported URL format');
    }
  } catch (error) {
    console.error('Error downloading image:', error);
    throw error;
  }
}

// Configure email transporter (global)
const emailTransporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASS
  }
});

// Helper function for sending Email with Photo (UPDATED with your requested format)
async function sendEmailWithPhoto(fullName, phone, toEmail, photoUrl) {
  // Check Gmail configuration
  if (!process.env.GMAIL_USER || !process.env.GMAIL_PASS || 
      process.env.GMAIL_USER === 'your_gmail@gmail.com') {
    console.warn('⚠️ Email: GMAIL credentials not configured properly. Skipping email.');
    console.warn('GMAIL_USER:', process.env.GMAIL_USER ? 'Set' : 'Missing');
    console.warn('GMAIL_PASS:', process.env.GMAIL_PASS ? 'Set' : 'Missing');
    return false;
  }

  try {
    // Task 1: Email - Download image as Buffer first to avoid Nodemailer URL fetching errors
    let attachmentContent;
    try {
      // Construct full URL if needed
      const fullPhotoUrl = photoUrl.startsWith('http') ? photoUrl : `${process.env.BASE_URL || 'https://your-domain.com'}${photoUrl}`;
      
      const response = await fetch(fullPhotoUrl);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      const arrayBuffer = await response.arrayBuffer();
      attachmentContent = Buffer.from(arrayBuffer);
      console.log('✅ Image downloaded successfully, size:', attachmentContent.length, 'bytes');
    } catch (fetchErr) {
      console.error('Failed to download image for email attachment:', fetchErr);
      throw fetchErr; // Fail this promise so it logs below
    }

    // Send email using the global transporter
    await emailTransporter.sendMail({
      from: `AI Booth <${process.env.GMAIL_USER}>`,
      to: toEmail,
      subject: 'Your AI Booth Photo 📸',
      text: `Hello ${fullName},\n\nThank you for using AI Booth! Here is your photo: ${photoUrl}`,
      attachments: [{ filename: 'photo.png', content: attachmentContent }]
    });
    
    console.log(`✅ Email sent to ${toEmail}`);
    return true;
    
  } catch (error) {
    console.error('❌ Email sending failed:', error.message);
    if (error.code === 'EAUTH') {
      console.error('Authentication failed. Please check:');
      console.error('1. GMAIL_USER is correct');
      console.error('2. GMAIL_PASS is an App Password (not regular password)');
      console.error('3. 2-Factor Authentication is enabled on Gmail');
      console.error('How to create App Password: https://support.google.com/accounts/answer/185833');
    }
    return false;
  }
}

// Helper function for sending WhatsApp with Photo Link
async function sendWhatsAppWithPhoto(fullName, phone, toPhone, photoUrl) {
  // Check if Twilio is properly configured
  if (!process.env.TWILIO_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_PHONE || 
      process.env.TWILIO_SID === 'your_twilio_sid') {
    console.warn('⚠️ WhatsApp: Twilio credentials not configured. Skipping WhatsApp.');
    return false;
  }

  try {
    // Clean phone number (remove any non-digit characters)
    const cleanedPhone = toPhone.replace(/\D/g, '');
    // Format with +91 if not already there (assuming Indian numbers for now)
    const finalPhone = cleanedPhone.length === 10 ? `+91${cleanedPhone}` : `+${cleanedPhone}`;

    const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH_TOKEN);
    
    // Construct full URL if it's relative
    const fullUrl = photoUrl.startsWith('http') ? photoUrl : `${process.env.BASE_URL || 'https://your-domain.com'}${photoUrl}`;

    console.log(`📱 WhatsApp: Attempting to send to ${finalPhone} with mediaUrl: ${fullUrl}`);

    const message = await client.messages.create({
      from: `whatsapp:${process.env.TWILIO_PHONE}`,
      to: `whatsapp:${finalPhone}`,
      body: `Hello ${fullName}! 👋\n\nThank you for using AI Booth!\n\nYou can view and download your photo here: ${fullUrl}\n\nBest regards,\nAI Booth Team`,
      mediaUrl: [fullUrl] 
    });
    
    console.log('✅ WhatsApp sent successfully:', message.sid);
    return true;
  } catch (error) {
    console.error('❌ WhatsApp failed:', error.message);
    return false;
  }
}

// Send Details Route V2 (with Firebase URL) - UPDATED
app.post('/api/send-details-v2', async (req, res) => {
  try {
    const { userId, photoUrl } = req.body;
    console.log(`📸 Processing send-details-v2 for User: ${userId}`);
    console.log(`📷 Photo URL: ${photoUrl}`);

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Update user's photo path
    user.lastPhotoPath = photoUrl;
    await user.save();

    let emailSent = false;
    let whatsappSent = false;

    // STEP 1: Try Email First (Primary) - Using your requested email function
    console.log('📧 Attempting to send email...');
    emailSent = await sendEmailWithPhoto(user.fullName, user.phone, user.gmail, photoUrl);
    
    // STEP 2: Try WhatsApp (Always try as backup if email fails OR always try both)
    console.log('💬 Attempting to send WhatsApp...');
    whatsappSent = await sendWhatsAppWithPhoto(user.fullName, user.phone, user.phone, photoUrl);

    // Response based on what worked
    if (emailSent || whatsappSent) {
      res.status(200).json({ 
        emailSent, 
        whatsappSent,
        message: emailSent ? 'Photo sent successfully via email' : 'Photo sent via WhatsApp (email failed)'
      });
    } else {
      res.status(500).json({ 
        emailSent: false, 
        whatsappSent: false,
        message: 'Failed to send photo via both email and WhatsApp. Please check your credentials.'
      });
    }

  } catch (error) {
    console.error('❌ Send details V2 error:', error);
    res.status(500).json({ 
      message: 'Internal server error',
      error: error.message 
    });
  }
});

// Test email configuration endpoint
app.post('/api/test-email', async (req, res) => {
  try {
    const { testEmail } = req.body;
    
    if (!testEmail) {
      return res.status(400).json({ message: 'Test email required' });
    }

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_PASS
      }
    });

    await transporter.verify();
    
    await transporter.sendMail({
      from: `"AI Booth Test" <${process.env.GMAIL_USER}>`,
      to: testEmail,
      subject: 'Test Email from AI Booth',
      text: 'If you receive this, your Gmail configuration is working correctly!'
    });

    res.json({ success: true, message: 'Test email sent successfully' });
  } catch (error) {
    console.error('Test email failed:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message,
      code: error.code
    });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📧 Gmail configured: ${process.env.GMAIL_USER ? 'Yes' : 'No'}`);
  console.log(`💬 Twilio configured: ${process.env.TWILIO_SID ? 'Yes' : 'No'}`);
});
