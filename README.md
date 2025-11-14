# Payment Processor System

A comprehensive M-Pesa payment processing system with automated PPPoE reconnection, SMS notifications, and multi-tenant ISP support.

## Table of Contents

- [Features](#features)
- [Installation](#installation)
- [Configuration](#configuration)
- [API Endpoints](#api-endpoints)
- [Database Schema](#database-schema)
- [Payment Processing](#payment-processing)
- [SMS Integration](#sms-integration)
- [Mikrotik Integration](#mikrotik-integration)
- [Troubleshooting](#troubleshooting)
- [Security Considerations](#security-considerations)
- [Monitoring](#monitoring)

---

## Features

- **M-Pesa Payment Processing** - Handle paybill payments with automatic routing
- **PPPoE Auto-Reconnection** - Automatically reconnect customers after successful payments
- **Multi-Tenant ISP Support** - Manage multiple ISPs with separate wallets and credits
- **SMS Notifications** - Real-time alerts for admins, ISPs, and customers
- **WhatsApp & SMS Credits** - Credit-based messaging system for ISPs
- **Comprehensive Logging** - Detailed debug logging for troubleshooting
- **Database Integration** - MySQL database with connection pooling

---

## Installation

### Prerequisites

- Node.js 16+
- MySQL 8.0+
- Mikrotik routers with API access
- TextSMS API account

### 1. Install Dependencies

```bash
npm install express mysql2 axios
```

### 2. Database Setup

Create the database and import the schema:

```sql
CREATE DATABASE onenetwo_onepppoe;
```

### 3. Start the Service

```bash
node callbackprocess.js
```

### 4. PM2 Setup (Production)

```bash
npm install -g pm2
pm2 start callbackprocess.js --name paymentproxy
pm2 save
pm2 startup
```

---

## Configuration

### Database Configuration

Update the database credentials in the code:

```javascript
const dbConfig = {
    host: 'localhost',
    database: 'onenetwo_onepppoe',
    user: 'root',
    password: 'your_password_here',
    connectionLimit: 10
};
```

### System Configuration

```javascript
const config = {
    adminPhones: ['254707819850', '254741390949'],
    mikrotikUser: 'apiuser',
    mikrotikPassword: '443JNZ',
    mikrotikPort: 8728,
    smsApiKey: '2657d153e378833edf31c1cfdfcb89f5',
    smsPartnerID: '12560',
    smsShortcode: 'TextSMS'
};
```

---

## API Endpoints

### Main Payment Endpoint

- **URL**: `POST /callbackprocess`
- **Description**: Processes incoming M-Pesa payments
- **Content-Type**: `application/json`
- **Request Body**: M-Pesa callback payload

### Health Check

- **URL**: `GET /health`
- **Description**: Service health monitoring
- **Response**: Database connection status

---

## Database Schema

### Core Tables

#### pppoe_users

Stores customer information and package details.

```sql
CREATE TABLE pppoe_users (
    id INT PRIMARY KEY AUTO_INCREMENT,
    full_name VARCHAR(255),
    username VARCHAR(100),
    account_name VARCHAR(100),
    amount DECIMAL(10,2),
    router_id INT,
    isp_id INT,
    status ENUM('active', 'inactive'),
    next_payment_date DATE,
    phone VARCHAR(20),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

#### paybill_payments

Logs all incoming M-Pesa payments.

```sql
CREATE TABLE paybill_payments (
    id INT PRIMARY KEY AUTO_INCREMENT,
    TransactionType VARCHAR(50),
    TransID VARCHAR(100) UNIQUE,
    TransTime VARCHAR(50),
    TransAmount DECIMAL(10,2),
    BusinessShortCode VARCHAR(50),
    BillRefNumber VARCHAR(100),
    InvoiceNumber VARCHAR(100),
    OrgAccountBalance DECIMAL(10,2),
    ThirdPartyTransID VARCHAR(100),
    MSISDN VARCHAR(20),
    FirstName VARCHAR(100),
    received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

#### isp_wallet

Manages ISP financial balances.

```sql
CREATE TABLE isp_wallet (
    id INT PRIMARY KEY AUTO_INCREMENT,
    isp_id INT,
    balance DECIMAL(10,2) DEFAULT 0,
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

#### payment_debug_log

Comprehensive logging for troubleshooting.

```sql
CREATE TABLE payment_debug_log (
    id INT AUTO_INCREMENT PRIMARY KEY,
    transaction_id VARCHAR(255) NOT NULL,
    category VARCHAR(100) NOT NULL,
    message TEXT NOT NULL,
    details JSON,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

---

## Payment Processing

### Payment Routing Logic

The system automatically routes payments based on BillRefNumber prefixes:

| BillRef Prefix | Payment Type | Description |
|----------------|--------------|-------------|
| `SMS` | SMS Credits | Purchases SMS credits for ISP (KES 0.50 per credit) |
| `WA` | WhatsApp Credits | Purchases WhatsApp credits for ISP (KES 0.20 per credit) |
| `ACC` | ISP Service | Direct ISP service payments to wallet |
| `0949AQ` (Customer ID) | Customer Payment | Customer internet payment with auto-reconnection |

### Customer Payment Flow

1. **Payment Received** → Log to `paybill_payments`
2. **User Lookup** → Find customer by `account_name`
3. **Transaction Recording** → Insert into `user_transactions_in`
4. **ISP Wallet Update** → Credit ISP wallet balance
5. **PPPoE Reconnection** → If payment ≥ package amount
6. **Notifications** → Send SMS to customer, ISP, and admins

### Success Criteria

- **Full Payment**: Reconnect + extend due date by 1 month
- **Partial Payment**: Update wallet only, no reconnection
- **Early Payment**: Extend from current due date
- **Late Payment**: Extend from current date

---

## SMS Integration

### SMS Service Provider

- **Provider**: TextSMS Kenya
- **Endpoint**: `https://sms.textsms.co.ke/api/services/sendsms/`
- **Format**: Automatic 254 conversion (07xxx → 2547xxx)

### Notification Types

#### Admin Notifications

Sent to all numbers in `config.adminPhones` for:
- All payment receipts
- System errors
- Unknown payment references

#### ISP Notifications

Sent to ISP contact numbers for:
- Customer payments
- Credit purchases
- Service payments

#### Customer Notifications

Sent to customer phone numbers for:
- Successful reconnection
- Payment confirmation

---

## Mikrotik Integration

### PPPoE Reconnection

```javascript
async function enablePPPoEUser(routerIp, username) {
    const apiUrl = "http://167.99.9.95/pppoe/enable-secret";
    // Calls external Mikrotik API service
}
```

---

## Troubleshooting

### Common Issues

#### Database Connection Errors

- Verify MySQL service is running
- Check database credentials
- Ensure database and tables exist

#### SMS Delivery Failures

- Validate SMS API credentials
- Check phone number formats
- Verify SMS credit balance

#### PPPoE Reconnection Failures

- Confirm Mikrotik API service is accessible
- Verify router IP and credentials
- Check user exists on router

### Debug Logging

The system maintains detailed logs in `payment_debug_log` table:

```sql
SELECT * FROM payment_debug_log 
WHERE transaction_id = 'TKE34A5QM8' 
ORDER BY created_at DESC;
```

### Health Monitoring

Check service status:

```bash
curl http://localhost:80/health
```

---

## Error Handling

The system includes comprehensive error handling with:

- Database transaction rollbacks
- Detailed error logging
- SMS notifications for critical failures
- Graceful degradation

---

## Security Considerations

- Database connection pooling
- Input validation and sanitization
- Error message sanitization
- Secure credential storage (consider environment variables for production)

---

## Monitoring

### Key Metrics to Monitor

- Payment success rate
- SMS delivery rate
- PPPoE reconnection success rate
- Database connection health
- API response times

---

## Support

For technical support, check:

1. Debug logs in `payment_debug_log` table
2. SMS delivery reports from TextSMS
3. Mikrotik API response logs
4. System console output

---

**Version**: 1.0  
**Last Updated**: 2024  
**Compatibility**: Node.js 16+, MySQL 8.0+