const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const nodemailer = require('nodemailer');
const twilio = require('twilio');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;

// Proper CORS for production
const allowedOrigins = [
  'https://nexa-ai-booth.web.app',
  'https://nexa-ai-booth.firebaseapp.com',
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:5175',
  'http://localhost:5176',
  'http://localhost:5177'
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  credentials: true
}));
app.use(express.json({ limit: '50mb' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Health Check Routes
app.get("/", (req, res) => {
  res.send("Backend is live");
});

app.get("/health", (req, res) => {
  res.status(200).json({ ok: true });
});

// Ensure uploads folder exists
if (!fs.existsSync('./uploads')) {
  fs.mkdirSync('./uploads');
}

// MongoDB Connection
const MONGO_URI = process.env.MONGO_URI;

console.log('Attempting to connect to MongoDB...');

if (!MONGO_URI) {
  console.error('MONGO_URI is missing in environment variables');
  process.exit(1);
}

mongoose.connect(MONGO_URI, {
  serverSelectionTimeoutMS: 10000
})
  .then(() => console.log('Connected to MongoDB Successfully'))
  .catch(err => {
    console.error('MongoDB connection error:', err.message);
    process.exit(1);
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

// Reuse Nodemailer transporter (Using direct IPv4 address to completely bypass DNS IPv6 resolution on Railway)
const transporter = nodemailer.createTransport({
  host: '74.125.137.108', // Direct IPv4 address for smtp.gmail.com
  port: 465,
  secure: true,
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASS
  },
  tls: {
    // Required when using direct IP instead of domain name
    rejectUnauthorized: false
  },
  name: 'smtp.gmail.com' // Explicitly specify the server name for HELO/EHLO
});

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

// Helper function for sending Email with Photo
async function sendEmailWithPhoto(fullName, phone, toEmail, photoPath) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_PASS || process.env.GMAIL_USER === 'your_gmail@gmail.com') {
    console.warn('Email: GMAIL credentials not configured. Skipping email.');
    return false;
  }

  const fullPath = path.join(__dirname, photoPath);

  await transporter.sendMail({
    from: `"AI Booth" <${process.env.GMAIL_USER}>`,
    to: toEmail,
    subject: 'Your AI Booth Photo 📸',
    text: `Hello ${fullName},\n\nThank you for using AI Booth! Here is your photo.`,
    attachments: [{ filename: 'photo.png', path: fullPath }]
  });
  return true;
}

// Helper function for sending WhatsApp with Photo Link (Twilio API)
async function sendWhatsAppWithPhoto(fullName, phone, toPhone, photoUrl) {
  // Check if Twilio is properly configured
  if (!process.env.TWILIO_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_PHONE || process.env.TWILIO_SID === 'your_twilio_sid') {
    console.warn('WhatsApp: Twilio credentials not configured. Skipping WhatsApp.');
    return false;
  }

  // Clean phone number (remove any non-digit characters)
  const cleanedPhone = toPhone.replace(/\D/g, '');
  // Format with +91 if not already there (assuming Indian numbers for now)
  const finalPhone = cleanedPhone.length === 10 ? `+91${cleanedPhone}` : `+${cleanedPhone}`;

  const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH_TOKEN);
  const fullUrl = `${process.env.BASE_URL}${photoUrl}`;

  console.log(`WhatsApp: Attempting to send to ${finalPhone} with mediaUrl: ${fullUrl}`);

  await client.messages.create({
    from: `whatsapp:${process.env.TWILIO_PHONE}`,
    to: `whatsapp:${finalPhone}`,
    body: `Hello ${fullName},\n\nThank you for using AI Booth! You can view and download your photo here: ${fullUrl}`,
    mediaUrl: [fullUrl] 
  });
  
  return true;
}

// Send Details Route
app.post('/api/send-details', async (req, res) => {
  try {
    const { userId } = req.body;
    const user = await User.findById(userId);
    
    if (!user) return res.status(404).json({ message: 'User not found' });

    let emailSent = false;
    let whatsappSent = false;

    // STEP 1: Try Email
    try {
      emailSent = await sendEmailWithPhoto(user.fullName, user.phone, user.gmail, user.lastPhotoPath);
    } catch (err) {
      console.error('Email failed:', err.message);
      emailSent = false;
    }

    // STEP 2: Try WhatsApp
    try {
      whatsappSent = await sendWhatsAppWithPhoto(user.fullName, user.phone, user.phone, user.lastPhotoPath);
    } catch (err) {
      console.error('WhatsApp failed:', err.message);
      whatsappSent = false;
    }

    res.status(200).json({ emailSent, whatsappSent });

  } catch (error) {
    console.error('Send details error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Send Details Route V2 (with Firebase URL)
app.post('/api/send-details-v2', async (req, res) => {
  try {
    const { userId, photoUrl } = req.body;
    console.log(`Processing send-details-v2 for User: ${userId}`);

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: 'User not found' });

    user.lastPhotoPath = photoUrl;
    await user.save();

    // Send Email and WhatsApp and wait for them to finish
    let emailSent = false;
    let whatsappSent = false;

    try {
      const results = await Promise.allSettled([
        // Task 1: Email
        (async () => {
          if (!process.env.GMAIL_USER || !process.env.GMAIL_PASS || process.env.GMAIL_USER === 'your_gmail@gmail.com') {
            throw new Error('Gmail credentials missing');
          }
          
          let attachmentContent;
          try {
            const response = await fetch(photoUrl);
            const arrayBuffer = await response.arrayBuffer();
            attachmentContent = Buffer.from(arrayBuffer);
          } catch (fetchErr) {
            console.error('Failed to download image for email attachment:', fetchErr);
            throw fetchErr;
          }

          await transporter.sendMail({
            from: `AI Booth <${process.env.GMAIL_USER}>`,
            to: user.gmail,
            subject: 'Your AI Booth Photo 📸',
            text: `Hello ${user.fullName},\n\nThank you for using AI Booth! Here is your photo: ${photoUrl}`,
            attachments: [{ filename: 'photo.png', content: attachmentContent }]
          });
          console.log(`Email sent to ${user.gmail}`);
          return true;
        })(),

        // Task 2: WhatsApp
        (async () => {
          const twilioSid = process.env.TWILIO_SID;
          const twilioToken = process.env.TWILIO_AUTH_TOKEN;
          const twilioPhone = process.env.TWILIO_PHONE;
          if (!twilioSid || !twilioToken || !twilioPhone) {
            throw new Error('Twilio credentials missing');
          }

          const cleanedPhone = user.phone.replace(/\D/g, '');
          const finalPhone = cleanedPhone.length === 10 ? `+91${cleanedPhone}` : `+${cleanedPhone}`;
          
          const client = twilio(twilioSid, twilioToken);
          await client.messages.create({
            from: `whatsapp:${twilioPhone}`,
            to: `whatsapp:${finalPhone}`,
            body: `Hello ${user.fullName}!\n\nThank you for using AI Booth. Here is your photo: ${photoUrl}`,
            mediaUrl: [photoUrl] 
          });
          console.log(`WhatsApp sent to ${finalPhone}`);
          return true;
        })()
      ]);
      
      // Check results
      if (results[0].status === 'fulfilled') {
        emailSent = true;
      } else {
        console.error('Email failed:', results[0].reason);
      }

      if (results[1].status === 'fulfilled') {
        whatsappSent = true;
      } else {
        console.error('WhatsApp failed:', results[1].reason);
      }

    } catch (err) {
      console.error('Delivery error:', err);
    }

    // Now send the actual response back to the frontend
    res.status(200).json({ 
      message: 'Delivery complete',
      photoUrl: photoUrl,
      emailSent,
      whatsappSent
    });

  } catch (error) {
    console.error('Send details V2 error:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
