// JSON payload for sending SMS
const smsPayload = {
    "apikey": "2657d153e378833edf31c1cfdfcb89f5",
    "partnerID": "12560",
    "message": "Hello! This is a test message from TextSMS API",
    "shortcode": "TextSMS",
    "mobile": "254793527494"
};



// Function to send SMS
async function sendSMS() {
    try {
        console.log("Sending SMS with payload:");
        console.log(JSON.stringify(smsPayload, null, 2));
        
        const response = await fetch('https://sms.textsms.co.ke/api/services/sendsms/', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(smsPayload)
        });
        
        const result = await response.json();
        
        console.log("\n=== RESPONSE ===");
        console.log(JSON.stringify(result, null, 2));
        
        return result;
    } catch (error) {
        console.error('Error:', error);
        return { error: error.message };
    }
}

// Execute the function
sendSMS();