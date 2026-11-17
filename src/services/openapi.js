// OpenAPI 3.0 description of the public fraud API.

function spec(req) {
    const host = req ? `${req.protocol}://${req.get('host')}` : 'http://localhost:3000';
    const assessment = {
        type: 'object',
        properties: {
            id: { type: 'string', example: 'asm_1042' },
            external_id: { type: 'string', nullable: true, example: 'pay_8f2k' },
            decision: { type: 'string', enum: ['allow', 'challenge', 'review'] },
            risk: { type: 'number', nullable: true, example: 0.91 },
            model_score: { type: 'number', nullable: true, example: 0.74 },
            reasons: { type: 'array', items: { type: 'string' }, example: ['Amount is 62 times the sender\'s usual payment', 'First payment to this recipient'] },
            signals: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, weight: { type: 'number' }, label: { type: 'string' } } } },
            explanation: {
                type: 'object',
                properties: {
                    base_value: { type: 'number', nullable: true },
                    contributions: { type: 'array', items: { type: 'object', properties: { feature: { type: 'string' }, value: { type: 'number' }, contribution: { type: 'number' } } } },
                },
            },
            model_version: { type: 'string', nullable: true },
            status: { type: 'string', enum: ['completed', 'declined', 'reversed'] },
            label: { type: 'string', nullable: true, enum: ['fraud', 'legit', null] },
            created_at: { type: 'string', format: 'date-time' },
        },
    };
    const error = { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } };
    return {
        openapi: '3.0.3',
        info: {
            title: 'SecureWallet Fraud API',
            version: '1.0.0',
            description: 'Real-time fraud assessment for mobile-money and wallet payments. Send each outgoing payment before completing it; act on the decision. A simulated service built for a final-year project: do not use it for real payments.',
        },
        servers: [{ url: `${host}/api/v1` }],
        components: {
            securitySchemes: { apiKey: { type: 'http', scheme: 'bearer', bearerFormat: 'swk_live_...' } },
            schemas: { Assessment: assessment, Error: error },
        },
        security: [{ apiKey: [] }],
        paths: {
            '/assess': {
                post: {
                    summary: 'Assess a payment before completing it',
                    description: 'Returns allow, challenge (ask the customer for a second factor) or review (hold for a person to check). Sending the same external_id again returns the first assessment instead of creating a new one.',
                    requestBody: {
                        required: true,
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    required: ['type', 'amount', 'account_id', 'account_balance'],
                                    properties: {
                                        external_id: { type: 'string', description: 'Your reference for the payment. Makes the call safe to retry.' },
                                        type: { type: 'string', enum: ['TRANSFER', 'CASH_OUT'] },
                                        amount: { type: 'number', example: 2500 },
                                        account_id: { type: 'string', description: 'Your identifier for the paying account', example: 'cust_118' },
                                        counterparty_id: { type: 'string', description: 'Required for TRANSFER: your identifier for the receiving account', example: 'cust_904' },
                                        account_balance: { type: 'number', description: 'Paying account balance before the payment', example: 2600 },
                                        counterparty_balance: { type: 'number', description: 'Receiving account balance before the payment', example: 120 },
                                    },
                                },
                            },
                        },
                    },
                    responses: {
                        201: { description: 'Assessed', content: { 'application/json': { schema: { $ref: '#/components/schemas/Assessment' } } } },
                        200: { description: 'The same external_id was assessed before; that assessment is returned' },
                        400: { description: 'Invalid request', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
                        401: { description: 'Missing or invalid API key' },
                        429: { description: 'Rate limit reached; see Retry-After' },
                    },
                },
            },
            '/assessments/{id}': {
                get: {
                    summary: 'Fetch an assessment',
                    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
                    responses: { 200: { description: 'The assessment', content: { 'application/json': { schema: { $ref: '#/components/schemas/Assessment' } } } }, 404: { description: 'Not found' } },
                },
            },
            '/assessments/{id}/outcome': {
                post: {
                    summary: 'Report what happened to the payment',
                    description: 'A declined or reversed payment no longer counts in the account\'s history.',
                    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
                    requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string', enum: ['completed', 'declined', 'reversed'] } } } } } },
                    responses: { 200: { description: 'Updated' } },
                },
            },
            '/assessments/{id}/feedback': {
                post: {
                    summary: 'Tell us whether the payment was fraud',
                    description: 'Labels are used to retrain the model. A challenger model trained with them is compared with the current model before it is promoted.',
                    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
                    requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { label: { type: 'string', enum: ['fraud', 'legit'] } } } } } },
                    responses: { 200: { description: 'Recorded' } },
                },
            },
            '/usage': {
                get: { summary: 'Assessments by day and decision over the last 30 days', responses: { 200: { description: 'Usage' } } },
            },
        },
        'x-webhooks': {
            'assessment.flagged': {
                description: 'Sent to your webhook URL when an assessment is challenge or review. Verify the SecureWallet-Signature header: t=<unix seconds>,v1=<HMAC-SHA256 of "<t>.<raw body>" with your webhook secret>.',
            },
        },
    };
}

module.exports = { spec };
