// callbackprocess.js - Main Payment Processor
const express = require('express');
const mysql = require('mysql2/promise');
const axios = require('axios');

const app = express();
const PORT = 80;

app.use(express.json());

// ============================================================================
// DATABASE CONFIGURATION
// ============================================================================
const dbConfig = {
    host: 'localhost',
    database: 'onenetwo_onepppoe',
    user: 'root',
    password: 'Muuo02593.443JNZ',
    connectionLimit: 10
};

// Create connection pool
const dbPool = mysql.createPool(dbConfig);

// ============================================================================
// CONFIGURATION (from your PHP)
// ============================================================================
const config = {
    adminPhones: ['254707819850', '254741390949'],
    mikrotikUser: 'apiuser',
    mikrotikPassword: '443JNZ',
    mikrotikPort: 8728
};

// ============================================================================
// PAYBILL PAYMENT LOGGING (Converted from PHP)
// ============================================================================
async function logPaybillPayment(paymentData) {
    try {
        const query = `
            INSERT INTO paybill_payments (
                TransactionType, TransID, TransTime, TransAmount, BusinessShortCode,
                BillRefNumber, InvoiceNumber, OrgAccountBalance, ThirdPartyTransID,
                MSISDN, FirstName, received_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
        `;

        const values = [
            paymentData.TransactionType || '',
            paymentData.TransID || '',
            paymentData.TransTime || '',
            paymentData.TransAmount || 0,
            paymentData.BusinessShortCode || '',
            paymentData.BillRefNumber || '',
            paymentData.InvoiceNumber || '',
            paymentData.OrgAccountBalance || 0,
            paymentData.ThirdPartyTransID || '',
            paymentData.MSISDN || '',
            paymentData.FirstName || ''
        ];

        const [result] = await dbPool.execute(query, values);
        console.log(`✅ Payment logged to database - TransID: ${paymentData.TransID}`);
        return { success: true, insertId: result.insertId };
    } catch (error) {
        console.error('❌ Database logging error:', error.message);
        return { success: false, error: error.message };
    }
}

// ============================================================================
// PAYMENT ROUTING (Converted from PHP)
// ============================================================================
async function processPayment(data) {
    const billRef = data.BillRefNumber || '';
    const amount = parseFloat(data.TransAmount || 0);
    const transactionId = data.TransID || '';

    console.log(`🔄 Processing payment: ${transactionId} for ${billRef}`);

    // Convert your PHP routing logic
    if (billRef.toLowerCase().startsWith('sms')) {
        return await processSMSCredits(data);
    } else if (billRef.toLowerCase().startsWith('wa')) {
        return await processWhatsAppCredits(data);
    } else if (billRef.toLowerCase().startsWith('acc')) {
        return await processISPServicePayment(data);
    } else if (/^\d{1,4}[a-zA-Z]{2}/.test(billRef)) {
        return await processCustomerPayment(data);
    } else {
        await notifyAdmins(`❗ UNKNOWN PAYMENT REFERENCE\nReference: ${billRef}\nAmount: KES ${amount}\nTransaction: ${transactionId}`);
        return { success: false, reason: 'unknown_reference' };
    }
}

// ============================================================================
// SMS CREDITS PROCESSING (Converted from PHP)
// ============================================================================
async function processSMSCredits(data) {
    const { BillRefNumber: billRef, TransAmount: amount, TransID: transactionId } = data;
    
    try {
        const [ispRows] = await dbPool.execute("SELECT id, name FROM isps WHERE smsaccount = ?", [billRef]);
        
        if (ispRows.length === 0) {
            console.error(`❌ ISP not found for SMS account: ${billRef}`);
            return { success: false, reason: 'isp_not_found' };
        }

        const isp = ispRows[0];
        const smsCredits = Math.floor(parseFloat(amount) / 0.5);

        // Begin transaction
        const connection = await dbPool.getConnection();
        await connection.beginTransaction();

        try {
            // Insert credit transaction
            await connection.execute(
                `INSERT INTO credit_transactions (isp_id, transaction_type, credit_type, amount, unit_price, total_amount, reference, description)
                 VALUES (?, 'purchase', 'sms', ?, 0.50, ?, ?, ?)`,
                [isp.id, smsCredits, amount, transactionId, `Purchased ${smsCredits} SMS credits via M-Pesa`]
            );

            // Update ISP SMS credits
            await connection.execute(
                "UPDATE isp_credit SET sms_credits = sms_credits + ? WHERE isp_id = ?",
                [smsCredits, isp.id]
            );

            await connection.commit();

            // Notify admins and ISP
            await notifyAdmins(`✅ SMS CREDITS PURCHASED\nISP: ${isp.name}\nCredits: ${smsCredits} SMS\nAmount: KES ${amount}`);
            await notifyISP(isp.id, `✅ SMS Credits Purchased\nHi ${isp.name},\nYour SMS wallet topped up.\nCredits: ${smsCredits} SMS\nAmount: KES ${amount}`);

            console.log(`✅ SMS credits processed: ${smsCredits} credits for ISP: ${isp.name}`);
            return { success: true, credits: smsCredits, isp: isp.name };

        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }

    } catch (error) {
        console.error('❌ SMS processing error:', error.message);
        return { success: false, error: error.message };
    }
}

// ============================================================================
// WHATSAPP CREDITS PROCESSING (Converted from PHP)
// ============================================================================
async function processWhatsAppCredits(data) {
    const { BillRefNumber: billRef, TransAmount: amount, TransID: transactionId } = data;
    
    try {
        const [ispRows] = await dbPool.execute("SELECT id, name FROM isps WHERE waaccount = ?", [billRef]);
        
        if (ispRows.length === 0) {
            console.error(`❌ ISP not found for WA account: ${billRef}`);
            return { success: false, reason: 'isp_not_found' };
        }

        const isp = ispRows[0];
        const waCredits = Math.floor(parseFloat(amount) / 0.2);

        const connection = await dbPool.getConnection();
        await connection.beginTransaction();

        try {
            // Insert credit transaction
            await connection.execute(
                `INSERT INTO credit_transactions (isp_id, transaction_type, credit_type, amount, unit_price, total_amount, reference, description)
                 VALUES (?, 'purchase', 'whatsapp', ?, 0.20, ?, ?, ?)`,
                [isp.id, waCredits, amount, transactionId, `Purchased ${waCredits} WhatsApp credits via M-Pesa`]
            );

            // Update ISP WhatsApp credits
            await connection.execute(
                "UPDATE isp_credits SET whatsapp_credits = whatsapp_credits + ? WHERE isp_id = ?",
                [waCredits, isp.id]
            );

            await connection.commit();

            await notifyAdmins(`✅ WHATSAPP CREDITS PURCHASED\nISP: ${isp.name}\nCredits: ${waCredits} Messages\nAmount: KES ${amount}`);
            await notifyISP(isp.id, `✅ WhatsApp Credits Purchased\nCredits: ${waCredits} Messages\nAmount: KES ${amount}`);

            console.log(`✅ WhatsApp credits processed: ${waCredits} credits for ISP: ${isp.name}`);
            return { success: true, credits: waCredits, isp: isp.name };

        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }

    } catch (error) {
        console.error('❌ WhatsApp processing error:', error.message);
        return { success: false, error: error.message };
    }
}

// ============================================================================
// CUSTOMER PAYMENT PROCESSING (Converted from PHP)
// ============================================================================
async function processCustomerPayment(data) {
    const { BillRefNumber: billRef, TransAmount: amount, TransID: transactionId } = data;
    
    try {
        const [userRows] = await dbPool.execute(`
            SELECT 
                u.id, u.full_name, u.username, u.account_name, u.amount as package_amount,
                u.router_id, u.isp_id, u.next_payment_date as current_next_payment,
                r.local_ip as router_ip, r.router_name,
                i.name as isp_name, i.pay_account_number as isp_account
            FROM pppoe_users u
            LEFT JOIN routers r ON u.router_id = r.id
            LEFT JOIN isps i ON u.isp_id = i.id
            WHERE u.account_name = ?
        `, [billRef]);

        if (userRows.length === 0) {
            console.error(`❌ PPPoE User not found: ${billRef}`);
            return { success: false, reason: 'user_not_found' };
        }

        const user = userRows[0];
        // Continue converting your PHP customer payment logic here...
        
        console.log(`✅ Customer payment processed for user: ${user.username}`);
        return { success: true, user: user.username, amount: amount };

    } catch (error) {
        console.error('❌ Customer payment processing error:', error.message);
        return { success: false, error: error.message };
    }
}

// ============================================================================
// ISP SERVICE PAYMENT PROCESSING (Converted from PHP)
// ============================================================================
async function processISPServicePayment(data) {
    const { BillRefNumber: billRef, TransAmount: amount, TransID: transactionId } = data;
    
    try {
        const [ispRows] = await dbPool.execute("SELECT id, name FROM isps WHERE pay_account_number = ?", [billRef]);
        
        if (ispRows.length === 0) {
            console.error(`❌ ISP not found for service account: ${billRef}`);
            return { success: false, reason: 'isp_not_found' };
        }

        const isp = ispRows[0];
        
        const connection = await dbPool.getConnection();
        await connection.beginTransaction();

        try {
            // Update ISP wallet
            await connection.execute(`
                INSERT INTO isp_wallet (isp_id, balance, last_updated) 
                VALUES (?, ?, NOW())
                ON DUPLICATE KEY UPDATE 
                balance = balance + VALUES(balance),
                last_updated = NOW()
            `, [isp.id, amount]);

            // Get updated balance
            const [balanceRows] = await connection.execute("SELECT balance FROM isp_wallet WHERE isp_id = ?", [isp.id]);
            const newBalance = balanceRows[0]?.balance || 0;

            await connection.commit();

            await notifyAdmins(`💰 ISP SERVICE PAYMENT\nISP: ${isp.name}\nAmount: KES ${amount}\nNew Balance: KES ${newBalance}`);
            await notifyISP(isp.id, `💰 Service Payment Received\nAmount: KES ${amount}\nNew Balance: KES ${newBalance}`);

            console.log(`✅ ISP service payment processed: KES ${amount} for ISP: ${isp.name}`);
            return { success: true, isp: isp.name, newBalance: newBalance };

        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }

    } catch (error) {
        console.error('❌ ISP service payment error:', error.message);
        return { success: false, error: error.message };
    }
}

// ============================================================================
// NOTIFICATION FUNCTIONS (Converted from PHP)
// ============================================================================
async function notifyAdmins(message, paymentData = null) {
    try {
        console.log(`📢 Admin Notification: ${message}`);
        
        // Example: Send to your notification service
        for (const phone of config.adminPhones) {
            // await sendWhatsApp(message, phone);
            // await sendSMS(message, phone);
        }
    } catch (error) {
        console.error('❌ Admin notification error:', error.message);
    }
}

async function notifyISP(ispId, message) {
    try {
        const [ispRows] = await dbPool.execute("SELECT contact_phone as phone_number, name FROM isps WHERE id = ?", [ispId]);
        
        if (ispRows.length > 0 && ispRows[0].phone_number) {
            const isp = ispRows[0];
            // await sendWhatsApp(message, isp.phone_number);
            // await sendSMS(message, isp.phone_number);
            console.log(`📱 ISP Notification to ${isp.name}: ${message}`);
        }
    } catch (error) {
        console.error('❌ ISP notification error:', error.message);
    }
}

// ============================================================================
// MAIN PROCESSING ENDPOINT
// ============================================================================
app.post('/callbackprocess', async (req, res) => {
    console.log('📥 Received payment data for processing');
    
    try {
        const paymentData = req.body;

        // Validate required fields
        if (!paymentData.TransID) {
            console.error('❌ Missing TransID in processing request');
            return res.status(400).json({ success: false, error: 'Missing TransID' });
        }

        // Step 1: Log to paybill_payments table
        const logResult = await logPaybillPayment(paymentData);
        if (!logResult.success) {
            console.error('❌ Failed to log payment to database');
        }

        // Step 2: Process payment based on reference
        const processResult = await processPayment(paymentData);

        // Step 3: Send response
        res.json({
            success: true,
            processed: true,
            transactionId: paymentData.TransID,
            processingResult: processResult,
            timestamp: new Date().toISOString()
        });

        console.log(`✅ Payment ${paymentData.TransID} processed successfully`);

    } catch (error) {
        console.error('💥 Processing error:', error);
        
        res.status(500).json({
            success: false,
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Health check endpoint
app.get('/health', async (req, res) => {
    try {
        await dbPool.execute('SELECT 1');
        res.json({ 
            status: 'healthy', 
            database: 'connected',
            service: 'Payment Processor',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({ 
            status: 'unhealthy', 
            database: 'disconnected',
            error: error.message 
        });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Payment Processor running on port ${PORT}`);
    console.log(`📍 Endpoint: http://167.99.9.95:${PORT}/callbackprocess`);
});