const express = require('express');
const authMiddleware = require('../middleware/authMiddleware');

const router = express.Router();

router.get('/protected', authMiddleware, (req, res) => {
    res.status(200).json({
        message: 'You have access to the protected route',
        userId: req.session.userId
    });
});

module.exports = router;