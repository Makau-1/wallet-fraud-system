const bcrypt = require('bcrypt');
const userModel = require('../models/userModel');
const db = require('../config/db');

const register = async (req, res) => {
    try {
        const { name, email, password } = req.body;

        // Validate required fields
        if (!name || !email || !password) {
            return res.status(400).json({
                message: 'Name, email and password are required'
            });
        }

        // Check if email already exists
        const existingUser = await userModel.findUserByEmail(email);

        if (existingUser) {
            return res.status(409).json({
                message: 'Email already registered'
            });
        }

        // Hash password
        const passwordHash = await bcrypt.hash(password, 10);

        // Create user
        const userId = await userModel.createUser(
            name,
            email,
            passwordHash
        );

        // Create wallet with balance 0
        await db.execute(
            'INSERT INTO wallets (user_id, balance) VALUES (?, ?)',
            [userId, 0]
        );

        // Return basic user information only
        return res.status(201).json({
            id: userId,
            name: name
        });

    } catch (error) {
        console.error('Registration error:', error.message);

        return res.status(500).json({
            message: 'Internal server error'
        });
    }
};

const login = async (req, res) => {
    try {
        const { email, password } = req.body;

        // Validate required fields
        if (!email || !password) {
            return res.status(400).json({
                message: 'Email and password are required'
            });
        }

        // Find user by email
        const user = await userModel.findUserByEmail(email);

        if (!user) {
            return res.status(401).json({
                message: 'Invalid email or password'
            });
        }

        // Compare password with stored hash
        const passwordMatch = await bcrypt.compare(
            password,
            user.passwordHash
        );

        if (!passwordMatch) {
            return res.status(401).json({
                message: 'Invalid email or password'
            });
        }

        // Store user ID in session
        req.session.userId = user.id;

        // Return user information
        return res.status(200).json({
            message: 'Login successful',
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                role: user.role
            }
        });

    } catch (error) {
        console.error('Login error:', error.message);

        return res.status(500).json({
            message: 'Internal server error'
        });
    }
};

module.exports = {
    register,
    login
};