// callbackprocess.js - Complete Payment Processor with Database Updates
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
// CONFIGURATION
// ============================================================================
const config = {
    adminPhones: ['254707819850', '254741390949'],
    mikrotikUser: 'apiuser',
    mikrotikPassword: '443JNZ',
    mikrotikPort: 8728
};

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================
function parseAmount(amount) {
    // Handle both string and number inputs, ensure we get a proper float
    if (typeof amount === 'string') {
        // Remove any non-numeric characters except decimal point
        const cleaned = amount.replace(/[^\d.]/g, '');
        return parseFloat(cleaned) || 0;
    }
    return parseFloat(amount) || 0;
}

function formatCurrency(amount) {
    const numAmount = parseAmount(amount);
    return `KES ${numAmount.toFixed(2)}`;
}

// ============================================================================
// PAYBILL PAYMENT LOGGING
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
            parseAmount(paymentData.TransAmount),
            paymentData.BusinessShortCode || '',
            paymentData.BillRefNumber || '',
            paymentData.InvoiceNumber || '',
            parseAmount(paymentData.OrgAccountBalance),
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
// DEBUG LOGGING FUNCTION
// ============================================================================
async function logDebugInfo(transactionId, category, message, details = {}) {
    try {
        const query = `
            INSERT INTO payment_debug_log 
            (transaction_id, category, message, details, created_at)
            VALUES (?, ?, ?, ?, NOW())
        `;
        
        const [result] = await dbPool.execute(query, [
            transactionId,
            category,
            message,
            JSON.stringify(details)
        ]);
        
        console.log(`🔍 DEBUG [${category}]: ${message}`);
        return result.insertId;
    } catch (error) {
        console.error('❌ Debug logging error:', error.message);
    }
}

// ============================================================================
// MIKROTIK AUTO RECONNECTION
// ============================================================================
async function enablePPPoEUser(routerIp, username) {
    try {
        const apiUrl = "http://167.99.9.95/pppoe/enable-secret";
        const postData = {
            ip: routerIp,
            port: config.mikrotikPort,
            username: username
        };

        const response = await axios.post(apiUrl, postData, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 10000
        });

        console.log(`✅ PPPoE reconnection response:`, response.data);
        return {
            success: response.status === 200 && response.data.success,
            message: response.data.message || 'Success',
            response: response.data
        };
    } catch (error) {
        console.error('❌ PPPoE reconnection error:', error.message);
        return {
            success: false,
            message: error.message,
            response: null
        };
    }
}

// ============================================================================
// PAYMENT ROUTING
// ============================================================================
async function processPayment(data) {
    const billRef = data.BillRefNumber || '';
    const amount = parseAmount(data.TransAmount);
    const transactionId = data.TransID || '';

    console.log(`🔄 Processing payment: ${transactionId} for ${billRef}, Amount: ${formatCurrency(amount)}`);

    // Log initial payment details for debugging
    await logDebugInfo(transactionId, 'PAYMENT_RECEIVED', 
        `Payment received - Reference: ${billRef}, Amount: ${formatCurrency(amount)}`,
        { billRef, amount, transactionId }
    );

    if (billRef.toLowerCase().startsWith('sms')) {
        return await processSMSCredits(data);
    } else if (billRef.toLowerCase().startsWith('wa')) {
        return await processWhatsAppCredits(data);
    } else if (billRef.toLowerCase().startsWith('acc')) {
        return await processISPServicePayment(data);
    } else if (/^\d{1,4}[a-zA-Z]{2}/.test(billRef)) {
        return await processCustomerPayment(data);
    } else {
        await logDebugInfo(transactionId, 'UNKNOWN_REFERENCE', 
            `Unknown payment reference format`, 
            { billRef, amount, transactionId }
        );
        await notifyAdmins(`❗ UNKNOWN PAYMENT REFERENCE\nReference: ${billRef}\nAmount: ${formatCurrency(amount)}\nTransaction: ${transactionId}`);
        return { success: false, reason: 'unknown_reference' };
    }
}

// ============================================================================
// CUSTOMER PAYMENT PROCESSING (COMPLETE LOGIC)
// ============================================================================
async function processCustomerPayment(data) {
    const { BillRefNumber: billRef, TransAmount: amountStr, TransID: transactionId } = data;
    const amount = parseAmount(amountStr);
    
    const connection = await dbPool.getConnection();
    
    try {
        // Log start of customer payment processing
        await logDebugInfo(transactionId, 'CUSTOMER_PAYMENT_START', 
            `Starting customer payment processing`, 
            { billRef, amount, transactionId }
        );

        // Get user details with router and ISP information
        const [userRows] = await connection.execute(`
            SELECT 
                u.id, 
                u.full_name, 
                u.username,
                u.account_name,
                u.amount as package_amount,
                u.router_id,
                u.isp_id,
                u.status,
                u.next_payment_date as current_next_payment,
                r.local_ip as router_ip,
                r.router_name,
                i.name as isp_name,
                i.pay_account_number as isp_account,
                i.contact_phone as isp_phone
            FROM pppoe_users u
            LEFT JOIN routers r ON u.router_id = r.id
            LEFT JOIN isps i ON u.isp_id = i.id
            WHERE u.account_name = ?
        `, [billRef]);

        if (userRows.length === 0) {
            console.error(`❌ PPPoE User not found: ${billRef}`);
            await logDebugInfo(transactionId, 'USER_NOT_FOUND', 
                `PPPoE user not found for account name`, 
                { billRef, amount, transactionId }
            );
            return { success: false, reason: 'user_not_found' };
        }

        const user = userRows[0];
        const packageAmount = parseAmount(user.package_amount);
        
        await logDebugInfo(transactionId, 'USER_FOUND', 
            `User found for payment processing`, 
            { 
                userId: user.id, 
                username: user.username, 
                packageAmount: packageAmount,
                currentStatus: user.status 
            }
        );

        await connection.beginTransaction();

        try {
            // 1. INSERT USER TRANSACTION RECORD
            const [txResult] = await connection.execute(`
                INSERT INTO user_transactions_in
                (isp_id, pppoe_user_id, amount, method, reference, received_at)
                VALUES (?, ?, ?, 'mpesa', ?, NOW())
            `, [user.isp_id, user.id, amount, transactionId]);

            await logDebugInfo(transactionId, 'TRANSACTION_RECORDED', 
                `User transaction recorded in database`, 
                { 
                    transactionId: txResult.insertId, 
                    ispId: user.isp_id, 
                    userId: user.id, 
                    amount: amount 
                }
            );

            console.log(`✅ User transaction recorded - ID: ${txResult.insertId}`);

            // 2. CHECK AND UPDATE ISP WALLET
            const [walletRows] = await connection.execute(
                "SELECT id, balance FROM isp_wallet WHERE isp_id = ?",
                [user.isp_id]
            );

            const existingWallet = walletRows[0];
            let walletAction = '';
            let previousBalance = 0;

            if (existingWallet) {
                previousBalance = parseAmount(existingWallet.balance);
                // Update existing wallet
                await connection.execute(`
                    UPDATE isp_wallet 
                    SET balance = balance + ?, 
                        last_updated = NOW() 
                    WHERE isp_id = ?
                `, [amount, user.isp_id]);
                walletAction = "Updated existing wallet";
            } else {
                // Create new wallet
                await connection.execute(`
                    INSERT INTO isp_wallet (isp_id, balance, last_updated) 
                    VALUES (?, ?, NOW())
                `, [user.isp_id, amount]);
                walletAction = "Created new wallet";
            }

            // 3. GET UPDATED WALLET BALANCE
            const [balanceRows] = await connection.execute(
                "SELECT balance FROM isp_wallet WHERE isp_id = ?",
                [user.isp_id]
            );
            const newBalance = parseAmount(balanceRows[0]?.balance || 0);

            await logDebugInfo(transactionId, 'WALLET_UPDATED', 
                `ISP wallet updated successfully`, 
                { 
                    ispId: user.isp_id, 
                    previousBalance: previousBalance,
                    amountAdded: amount,
                    newBalance: newBalance,
                    walletAction: walletAction 
                }
            );

            let reconnectionStatus = "Not attempted";
            let reconnectionDetails = "";
            let newNextPaymentDate = "";

            // 4. PROCESS PPPoE RECONNECTION IF PAYMENT IS SUFFICIENT
            if (amount >= packageAmount) {
                if (user.router_ip && user.username) {
                    const enableResult = await enablePPPoEUser(user.router_ip, user.username);

                    await logDebugInfo(transactionId, 'MIKROTIK_ATTEMPT', 
                        `Attempted Mikrotik reconnection`, 
                        { 
                            routerIp: user.router_ip, 
                            username: user.username,
                            mikrotikResult: enableResult 
                        }
                    );

                    if (enableResult.success) {
                        // ✅ Success - reconnect and update status + next payment date
                        await connection.execute(`
                            UPDATE pppoe_users 
                            SET status = 'active',
                                next_payment_date = CASE 
                                    WHEN next_payment_date > CURDATE() THEN DATE_ADD(next_payment_date, INTERVAL 1 MONTH)
                                    ELSE DATE_ADD(CURDATE(), INTERVAL 1 MONTH)
                                END,
                                last_reconnected_at = NOW()
                            WHERE id = ?
                        `, [user.id]);

                        // Get new next payment date
                        const [dateRows] = await connection.execute(
                            "SELECT next_payment_date FROM pppoe_users WHERE id = ?",
                            [user.id]
                        );
                        newNextPaymentDate = dateRows[0]?.next_payment_date;

                        reconnectionStatus = "CONNECTED";
                        const paymentTiming = (user.current_next_payment > new Date().toISOString().split('T')[0]) ? "EARLY" : "ON_TIME/LATE";
                        reconnectionDetails = `User reconnected via Mikrotik API | Payment: ${paymentTiming}`;

                        await logDebugInfo(transactionId, 'RECONNECTION_SUCCESS', 
                            `User reconnected successfully`, 
                            { 
                                newNextPaymentDate: newNextPaymentDate,
                                paymentTiming: paymentTiming 
                            }
                        );

                    } else {
                        // ❌ Mikrotik failed - update date only, keep status as is
                        await connection.execute(`
                            UPDATE pppoe_users 
                            SET next_payment_date = CASE 
                                WHEN next_payment_date > CURDATE() THEN DATE_ADD(next_payment_date, INTERVAL 1 MONTH)
                                ELSE DATE_ADD(CURDATE(), INTERVAL 1 MONTH)
                            END
                            WHERE id = ?
                        `, [user.id]);

                        const [dateRows] = await connection.execute(
                            "SELECT next_payment_date FROM pppoe_users WHERE id = ?",
                            [user.id]
                        );
                        newNextPaymentDate = dateRows[0]?.next_payment_date;

                        reconnectionStatus = "FAILED (DATE UPDATED)";
                        reconnectionDetails = `Mikrotik API failed but date updated: ${enableResult.message}`;

                        await logDebugInfo(transactionId, 'RECONNECTION_FAILED', 
                            `Mikrotik reconnection failed`, 
                            { 
                                newNextPaymentDate: newNextPaymentDate,
                                error: enableResult.message 
                            }
                        );

                        console.error(`❌ PPPoE reconnection failed: ${enableResult.message}`);
                    }
                } else {
                    reconnectionStatus = "NO ROUTER CONFIGURED";
                    reconnectionDetails = "Router IP or username missing";
                    
                    await logDebugInfo(transactionId, 'NO_ROUTER_CONFIG', 
                        `Router configuration missing`, 
                        { 
                            hasRouterIp: !!user.router_ip,
                            hasUsername: !!user.username 
                        }
                    );
                }
            } else {
                reconnectionStatus = "INSUFFICIENT PAYMENT";
                reconnectionDetails = `Payment ${formatCurrency(amount)} below package amount ${formatCurrency(packageAmount)}`;
                
                await logDebugInfo(transactionId, 'INSUFFICIENT_PAYMENT', 
                    `Payment amount insufficient for reconnection`, 
                    { 
                        amountPaid: amount,
                        packageAmount: packageAmount,
                        difference: (packageAmount - amount) 
                    }
                );
            }

            await connection.commit();

            // 5. SEND NOTIFICATIONS
            const nextPaymentFormatted = newNextPaymentDate ? new Date(newNextPaymentDate).toLocaleDateString() : 'Not updated';
            const currentDueDate = user.current_next_payment ? new Date(user.current_next_payment).toLocaleDateString() : 'Not set';

            const summary = `*CUSTOMER PAYMENT RECEIVED*\n\n` +
                           `Customer: ${user.full_name}\n` +
                           `Username: ${user.username}\n` +
                           `Router: ${user.router_name}\n` +
                           `Paid: ${formatCurrency(amount)}\n` +
                           `Package: ${formatCurrency(packageAmount)}\n` +
                           `Transaction: ${transactionId}\n\n` +
                           `Previous Due: ${currentDueDate}\n` +
                           `New Due Date: ${nextPaymentFormatted}\n\n` +
                           `ISP Wallet: ${formatCurrency(newBalance)}\n` +
                           `Wallet Action: ${walletAction}\n\n` +
                           `Reconnection Status: ${reconnectionStatus}\n` +
                           `${reconnectionDetails}`;

            await notifyAdmins(summary);
            await notifyISP(user.isp_id, summary);

            // Final success log
            await logDebugInfo(transactionId, 'PROCESSING_COMPLETE', 
                `Customer payment processing completed successfully`, 
                { 
                    reconnectionStatus: reconnectionStatus,
                    walletUpdated: true,
                    transactionRecorded: true,
                    finalBalance: newBalance 
                }
            );

            console.log(`✅ Customer payment fully processed for: ${user.username}`);
            return { 
                success: true, 
                user: user.username, 
                amount: amount,
                reconnectionStatus: reconnectionStatus,
                walletUpdated: true,
                transactionRecorded: true
            };

        } catch (error) {
            await connection.rollback();
            await logDebugInfo(transactionId, 'PROCESSING_ERROR', 
                `Error during payment processing`, 
                { error: error.message, stack: error.stack }
            );
            throw error;
        } finally {
            connection.release();
        }

    } catch (error) {
        console.error('❌ Customer payment processing error:', error.message);
        await logDebugInfo(transactionId, 'FATAL_ERROR', 
            `Fatal error in customer payment processing`, 
            { error: error.message, billRef: billRef }
        );
        return { success: false, error: error.message };
    }
}

// ============================================================================
// SMS CREDITS PROCESSING (COMPLETE LOGIC)
// ============================================================================
async function processSMSCredits(data) {
    const { BillRefNumber: billRef, TransAmount: amountStr, TransID: transactionId } = data;
    const amount = parseAmount(amountStr);
    
    const connection = await dbPool.getConnection();
    
    try {
        await logDebugInfo(transactionId, 'SMS_PROCESSING_START', 
            `Starting SMS credits processing`, 
            { billRef, amount, transactionId }
        );

        const [ispRows] = await connection.execute("SELECT id, name FROM isps WHERE smsaccount = ?", [billRef]);
        
        if (ispRows.length === 0) {
            console.error(`❌ ISP not found for SMS account: ${billRef}`);
            await logDebugInfo(transactionId, 'SMS_ISP_NOT_FOUND', 
                `ISP not found for SMS account`, 
                { billRef }
            );
            return { success: false, reason: 'isp_not_found' };
        }

        const isp = ispRows[0];
        const smsCredits = Math.floor(amount / 0.5);

        await connection.beginTransaction();

        try {
            // 1. Insert credit transaction
            await connection.execute(
                `INSERT INTO credit_transactions (isp_id, transaction_type, credit_type, amount, unit_price, total_amount, reference, description)
                 VALUES (?, 'purchase', 'sms', ?, 0.50, ?, ?, ?)`,
                [isp.id, smsCredits, amount, transactionId, `Purchased ${smsCredits} SMS credits via M-Pesa`]
            );

            // 2. Update ISP SMS credits
            await connection.execute(
                "UPDATE isp_credit SET sms_credits = sms_credits + ? WHERE isp_id = ?",
                [smsCredits, isp.id]
            );

            await connection.commit();

            await logDebugInfo(transactionId, 'SMS_PROCESSING_COMPLETE', 
                `SMS credits processed successfully`, 
                { 
                    ispId: isp.id, 
                    ispName: isp.name, 
                    smsCredits: smsCredits, 
                    amount: amount 
                }
            );

            // 3. Notify admins and ISP
            await notifyAdmins(`✅ SMS CREDITS PURCHASED\nISP: ${isp.name}\nCredits: ${smsCredits} SMS\nAmount: ${formatCurrency(amount)}`);
            await notifyISP(isp.id, `✅ SMS Credits Purchased\nHi ${isp.name},\nYour SMS wallet topped up.\nCredits: ${smsCredits} SMS\nAmount: ${formatCurrency(amount)}`);

            console.log(`✅ SMS credits processed: ${smsCredits} credits for ISP: ${isp.name}`);
            return { success: true, credits: smsCredits, isp: isp.name };

        } catch (error) {
            await connection.rollback();
            await logDebugInfo(transactionId, 'SMS_PROCESSING_ERROR', 
                `Error during SMS credits processing`, 
                { error: error.message }
            );
            throw error;
        } finally {
            connection.release();
        }

    } catch (error) {
        console.error('❌ SMS processing error:', error.message);
        await logDebugInfo(transactionId, 'SMS_FATAL_ERROR', 
            `Fatal error in SMS processing`, 
            { error: error.message }
        );
        return { success: false, error: error.message };
    }
}

// ============================================================================
// WHATSAPP CREDITS PROCESSING (COMPLETE LOGIC)
// ============================================================================
async function processWhatsAppCredits(data) {
    const { BillRefNumber: billRef, TransAmount: amountStr, TransID: transactionId } = data;
    const amount = parseAmount(amountStr);
    
    const connection = await dbPool.getConnection();
    
    try {
        await logDebugInfo(transactionId, 'WHATSAPP_PROCESSING_START', 
            `Starting WhatsApp credits processing`, 
            { billRef, amount, transactionId }
        );

        const [ispRows] = await connection.execute("SELECT id, name FROM isps WHERE waaccount = ?", [billRef]);
        
        if (ispRows.length === 0) {
            console.error(`❌ ISP not found for WA account: ${billRef}`);
            await logDebugInfo(transactionId, 'WHATSAPP_ISP_NOT_FOUND', 
                `ISP not found for WhatsApp account`, 
                { billRef }
            );
            return { success: false, reason: 'isp_not_found' };
        }

        const isp = ispRows[0];
        const waCredits = Math.floor(amount / 0.2);

        await connection.beginTransaction();

        try {
            // 1. Insert credit transaction
            await connection.execute(
                `INSERT INTO credit_transactions (isp_id, transaction_type, credit_type, amount, unit_price, total_amount, reference, description)
                 VALUES (?, 'purchase', 'whatsapp', ?, 0.20, ?, ?, ?)`,
                [isp.id, waCredits, amount, transactionId, `Purchased ${waCredits} WhatsApp credits via M-Pesa`]
            );

            // 2. Update ISP WhatsApp credits
            await connection.execute(
                "UPDATE isp_credits SET whatsapp_credits = whatsapp_credits + ? WHERE isp_id = ?",
                [waCredits, isp.id]
            );

            await connection.commit();

            await logDebugInfo(transactionId, 'WHATSAPP_PROCESSING_COMPLETE', 
                `WhatsApp credits processed successfully`, 
                { 
                    ispId: isp.id, 
                    ispName: isp.name, 
                    waCredits: waCredits, 
                    amount: amount 
                }
            );

            // 3. Notify admins and ISP
            await notifyAdmins(`✅ WHATSAPP CREDITS PURCHASED\nISP: ${isp.name}\nCredits: ${waCredits} Messages\nAmount: ${formatCurrency(amount)}`);
            await notifyISP(isp.id, `✅ WhatsApp Credits Purchased\nCredits: ${waCredits} Messages\nAmount: ${formatCurrency(amount)}`);

            console.log(`✅ WhatsApp credits processed: ${waCredits} credits for ISP: ${isp.name}`);
            return { success: true, credits: waCredits, isp: isp.name };

        } catch (error) {
            await connection.rollback();
            await logDebugInfo(transactionId, 'WHATSAPP_PROCESSING_ERROR', 
                `Error during WhatsApp credits processing`, 
                { error: error.message }
            );
            throw error;
        } finally {
            connection.release();
        }

    } catch (error) {
        console.error('❌ WhatsApp processing error:', error.message);
        await logDebugInfo(transactionId, 'WHATSAPP_FATAL_ERROR', 
            `Fatal error in WhatsApp processing`, 
            { error: error.message }
        );
        return { success: false, error: error.message };
    }
}

// ============================================================================
// ISP SERVICE PAYMENT PROCESSING (COMPLETE LOGIC)
// ============================================================================
async function processISPServicePayment(data) {
    const { BillRefNumber: billRef, TransAmount: amountStr, TransID: transactionId } = data;
    const amount = parseAmount(amountStr);
    
    const connection = await dbPool.getConnection();
    
    try {
        await logDebugInfo(transactionId, 'ISP_SERVICE_PAYMENT_START', 
            `Starting ISP service payment processing`, 
            { billRef, amount, transactionId }
        );

        const [ispRows] = await connection.execute("SELECT id, name FROM isps WHERE pay_account_number = ?", [billRef]);
        
        if (ispRows.length === 0) {
            console.error(`❌ ISP not found for service account: ${billRef}`);
            await logDebugInfo(transactionId, 'ISP_SERVICE_NOT_FOUND', 
                `ISP not found for service account`, 
                { billRef }
            );
            return { success: false, reason: 'isp_not_found' };
        }

        const isp = ispRows[0];
        
        await connection.beginTransaction();

        try {
            // 1. Update ISP wallet
            await connection.execute(`
                INSERT INTO isp_wallet (isp_id, balance, last_updated) 
                VALUES (?, ?, NOW())
                ON DUPLICATE KEY UPDATE 
                balance = balance + VALUES(balance),
                last_updated = NOW()
            `, [isp.id, amount]);

            // 2. Get updated balance
            const [balanceRows] = await connection.execute("SELECT balance FROM isp_wallet WHERE isp_id = ?", [isp.id]);
            const newBalance = parseAmount(balanceRows[0]?.balance || 0);

            await connection.commit();

            await logDebugInfo(transactionId, 'ISP_SERVICE_PAYMENT_COMPLETE', 
                `ISP service payment processed successfully`, 
                { 
                    ispId: isp.id, 
                    ispName: isp.name, 
                    amount: amount, 
                    newBalance: newBalance 
                }
            );

            // 3. Notify admins and ISP
            await notifyAdmins(`💰 ISP SERVICE PAYMENT\nISP: ${isp.name}\nAmount: ${formatCurrency(amount)}\nNew Balance: ${formatCurrency(newBalance)}`);
            await notifyISP(isp.id, `💰 Service Payment Received\nAmount: ${formatCurrency(amount)}\nNew Balance: ${formatCurrency(newBalance)}`);

            console.log(`✅ ISP service payment processed: ${formatCurrency(amount)} for ISP: ${isp.name}`);
            return { success: true, isp: isp.name, newBalance: newBalance };

        } catch (error) {
            await connection.rollback();
            await logDebugInfo(transactionId, 'ISP_SERVICE_PAYMENT_ERROR', 
                `Error during ISP service payment processing`, 
                { error: error.message }
            );
            throw error;
        } finally {
            connection.release();
        }

    } catch (error) {
        console.error('❌ ISP service payment error:', error.message);
        await logDebugInfo(transactionId, 'ISP_SERVICE_FATAL_ERROR', 
            `Fatal error in ISP service payment processing`, 
            { error: error.message }
        );
        return { success: false, error: error.message };
    }
}

// ============================================================================
// NOTIFICATION FUNCTIONS
// ============================================================================
async function notifyAdmins(message, paymentData = null) {
    try {
        console.log(`📢 Admin Notification: ${message}`);
        
        // Add your WhatsApp/SMS notification logic here
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

// Create debug log table if it doesn't exist
async function initializeDebugTable() {
    try {
        const createTableQuery = `
            CREATE TABLE IF NOT EXISTS payment_debug_log (
                id INT AUTO_INCREMENT PRIMARY KEY,
                transaction_id VARCHAR(255) NOT NULL,
                category VARCHAR(100) NOT NULL,
                message TEXT NOT NULL,
                details JSON,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_transaction_id (transaction_id),
                INDEX idx_category (category),
                INDEX idx_created_at (created_at)
            )
        `;
        await dbPool.execute(createTableQuery);
        console.log('✅ Debug log table initialized');
    } catch (error) {
        console.error('❌ Failed to initialize debug table:', error.message);
    }
}

// Start server
app.listen(PORT, async () => {
    await initializeDebugTable();
    console.log(`🚀 Payment Processor running on port ${PORT}`);
    console.log(`📍 Endpoint: http://167.99.9.95:${PORT}/callbackprocess`);
    console.log('🔍 Debug logging enabled - check payment_debug_log table for details');
});