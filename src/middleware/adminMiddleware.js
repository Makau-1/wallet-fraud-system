
const adminMiddleware = (req, res, next) => {
    if (!req.session.userId) {
        return res.status(401).json({
            message: 'Authentication required'
        });
    }

    if (req.session.role !== 'admin') {
        return res.status(403).json({
            message: 'Administrator access required'
        });
    }

    next();
};

module.exports = adminMiddleware;
