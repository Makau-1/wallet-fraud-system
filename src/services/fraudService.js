const ML_URL = (
    process.env.ML_URL || 'http://127.0.0.1:8000'
).replace(/\/+$/, '');


// ==================================================
// REQUEST A FRAUD SCORE FROM FASTAPI
// ==================================================

async function scoreTransaction(payload) {
    console.log(
        '[FraudService] Calling FastAPI:',
        `${ML_URL}/score`,
        '| Type:',
        payload.type
    );

    try {
        const response = await fetch(`${ML_URL}/score`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(2000),
        });

        console.log(
            '[FraudService] FastAPI HTTP status:',
            response.status
        );

        if (!response.ok) {
            const responseText = await response.text();

            console.error(
                '[FraudService] FastAPI returned an error:',
                response.status,
                responseText
            );

            return null;
        }

        const result = await response.json();

        if (
            typeof result.fraud_score !== 'number' ||
            !Number.isFinite(result.fraud_score) ||
            typeof result.flagged !== 'boolean'
        ) {
            console.error(
                '[FraudService] Invalid FastAPI response:',
                result
            );

            return null;
        }

        console.log(
            '[FraudService] Model result:',
            {
                fraud_score: result.fraud_score,
                flagged: result.flagged,
                model: result.model,
            }
        );

        return result;
    } catch (error) {
        console.error(
            '[FraudService] FastAPI request failed:',
            error.message,
            error.cause?.message || ''
        );

        return null;
    }
}


// ==================================================
// SAVE A SCORING RESULT AND CREATE AN ALERT IF FLAGGED
// ==================================================

async function scoreAndRecordTransaction(
    db,
    transactionId,
    payload
) {
    console.log(
        '[FraudService] Scoring started for transaction:',
        transactionId
    );

    const result = await scoreTransaction(payload);

    // If the model service is unavailable, leave the wallet
    // transaction completed and mark it unscored.
    if (!result) {
        console.warn(
            '[FraudService] No scoring result. Marking transaction unscored:',
            transactionId
        );

        try {
            const [updateResult] = await db.execute(
                `UPDATE transactions
                 SET scoring_status = 'unscored'
                 WHERE id = ?`,
                [transactionId]
            );

            console.log(
                '[FraudService] Unscored status update:',
                updateResult.affectedRows,
                'row(s)'
            );
        } catch (error) {
            console.error(
                '[FraudService] Could not mark transaction unscored:',
                error.message
            );
        }

        return null;
    }

    let connection = null;

    try {
        connection = await db.getConnection();

        await connection.beginTransaction();

        // Save the actual model score.
        const [updateResult] = await connection.execute(
            `UPDATE transactions
             SET fraud_score = ?,
                 scoring_status = 'scored'
             WHERE id = ?`,
            [
                result.fraud_score,
                transactionId,
            ]
        );

        console.log(
            '[FraudService] Transaction update affected rows:',
            updateResult.affectedRows
        );

        if (updateResult.affectedRows === 0) {
            throw new Error(
                `Transaction ${transactionId} was not found`
            );
        }

        // Create an alert only when FastAPI says it is flagged.
        if (result.flagged) {
            const notes = [
                `Model: ${result.model || 'unknown'}`,
                `Threshold: ${result.threshold ?? 'unknown'}`,
                `Score is probability: ${
                    result.score_is_probability ?? 'unknown'
                }`,
            ].join('; ');

            const [alertResult] = await connection.execute(
                `INSERT INTO fraud_alerts
                    (transaction_id, alert_type, score, status,
                     notes, created_at, updated_at)
                 VALUES (?, ?, ?, 'pending', ?,
                         CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
                [
                    transactionId,
                    'model_flag',
                    result.fraud_score,
                    notes,
                ]
            );

            console.log(
                '[FraudService] Fraud alert created. Alert ID:',
                alertResult.insertId,
                '| Transaction ID:',
                transactionId
            );
        } else {
            console.log(
                '[FraudService] Transaction not flagged:',
                transactionId
            );
        }

        await connection.commit();

        console.log(
            '[FraudService] Scoring saved successfully:',
            transactionId
        );

        return result;
    } catch (error) {
        if (connection) {
            try {
                await connection.rollback();
            } catch (rollbackError) {
                console.error(
                    '[FraudService] Rollback failed:',
                    rollbackError.message
                );
            }
        }

        console.error(
            '[FraudService] Failed to save scoring result:',
            error.message
        );

        // The wallet transaction was committed before this service
        // was called. Do not reverse it because scoring persistence
        // failed.
        try {
            const [statusResult] = await db.execute(
                `UPDATE transactions
                 SET scoring_status = 'unscored'
                 WHERE id = ?`,
                [transactionId]
            );

            console.log(
                '[FraudService] Fallback status update:',
                statusResult.affectedRows,
                'row(s)'
            );
        } catch (statusError) {
            console.error(
                '[FraudService] Could not update fallback status:',
                statusError.message
            );
        }

        return null;
    } finally {
        if (connection) {
            connection.release();
        }
    }
}


module.exports = {
    scoreTransaction,
    scoreAndRecordTransaction,
};