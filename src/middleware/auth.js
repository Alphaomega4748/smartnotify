// middleware/auth.js
const jwt  = require('jsonwebtoken');
const { User } = require('../models');

const protect = async (req, res, next) => {
  try {
    // Support Bearer token OR API key
    const token = req.headers.authorization?.startsWith('Bearer ')
      ? req.headers.authorization.split(' ')[1]
      : null;
    const apiKey = req.headers['x-api-key'];

    if (apiKey) {
      const user = await User.findOne({ apiKey });
      if (!user) return res.status(401).json({ success: false, message: 'Invalid API key' });
      req.user = user;
      return next();
    }

    if (token) {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      req.user = await User.findById(decoded.id).select('-password');
      if (!req.user) return res.status(401).json({ success: false, message: 'User not found' });
      return next();
    }

    return res.status(401).json({ success: false, message: 'No auth token provided' });
  } catch {
    res.status(401).json({ success: false, message: 'Token invalid or expired' });
  }
};

module.exports = { protect };
