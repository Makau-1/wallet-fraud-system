const bcrypt = require('bcrypt');
const userModel = require('../models/userModel');
const db = require('../config/db');

const register = async (req, res) => {
    try {
        const { name, email, password } = req.body;

        if (!name || !email || !password) {
            return res.status(400).json({
                message: 'Name, email and password are required'
            });
        }

        const existingUser = await userModel.findUserByEmail(email);

        if (existingUser) {
            return res.status(409).json({
                message: 'Email already registered'
            });
        }

        const passwordHash = await bcrypt.hash(password, 10);

        const userId = await userModel.createUser(
            name,
            email,
            passwordHash
        );

        await db.execute(
            'INSERT INTO wallets (user_id, balance) VALUES (?, ?)',
            [userId, 0]
        );

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

        if (!email || !password) {
            return res.status(400).json({
                message: 'Email and password are required'
            });
        }

        const user = await userModel.findUserByEmail(email);

        if (!user) {
            return res.status(401).json({
                message: 'Invalid email or password'
            });
        }

        const passwordMatch = await bcrypt.compare(
            password,
            user.passwordHash
        );

        if (!passwordMatch) {
            return res.status(401).json({
                message: 'Invalid email or password'
            });
        }

        req.session.userId = user.id;

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